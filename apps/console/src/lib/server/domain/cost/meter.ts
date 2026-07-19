import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import { Effect, Schema } from "effect";

import { required } from "#format";

import { ISO_DATETIME_OFFSET_RE } from "../schema-conventions.ts";
import type { CostComparisonRequest } from "./compare.ts";

export interface MeterSide {
	readonly totalCost: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheCreationTokens: number;
	readonly cacheReadTokens: number;
	readonly totalTokens: number;
	readonly sessionCount: number;
	readonly costPerSession?: number;
	readonly tokensPerSession?: number;
}

export interface MeterPricingModel {
	readonly matched_pattern: string;
	readonly input_cost_per_mtok: number;
	readonly output_cost_per_mtok: number;
	readonly cache_write_cost_per_mtok: number;
	readonly cache_read_cost_per_mtok: number;
	readonly cost_source: string;
}

export interface MeterComparison {
	readonly left: MeterSide;
	readonly right: MeterSide;
	readonly pricing: {
		readonly source: string;
		readonly table_version: string;
		readonly digest: string;
		readonly effective_row_count: number;
		readonly cost_source: string;
		readonly models: Readonly<Record<string, MeterPricingModel>>;
	};
	readonly observedAt: string;
	readonly query: string;
	readonly executionMs: number;
	readonly complete: true;
}

export interface CostMeter {
	compare(input: CostComparisonRequest): Promise<MeterComparison>;
}

interface AgentsViewCostMeterConfig {
	readonly url: string;
	readonly hostHeader?: string | null;
	readonly token?: string | null;
	readonly timeoutMs?: number;
}

const numberDefaultZero = Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0)));
const sideSchema = Schema.Struct({
	totalCost: Schema.Number,
	inputTokens: Schema.Number,
	outputTokens: Schema.Number,
	cacheCreationTokens: Schema.Number,
	cacheReadTokens: Schema.Number,
	totalTokens: Schema.Number,
	sessionCount: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
	costPerSession: numberDefaultZero,
	tokensPerSession: numberDefaultZero,
}).check(
	Schema.makeFilter(
		(side) =>
			side.totalTokens ===
				side.inputTokens + side.outputTokens + side.cacheCreationTokens + side.cacheReadTokens ||
			"token total does not match its components",
	),
);
const pairwiseSchema = Schema.Struct({ left: sideSchema, right: sideSchema });
const pricingModelSchema = Schema.Struct({
	matched_pattern: Schema.String,
	input_cost_per_mtok: Schema.Number,
	output_cost_per_mtok: Schema.Number,
	cache_write_cost_per_mtok: Schema.Number,
	cache_read_cost_per_mtok: Schema.Number,
	cost_source: Schema.String,
});
const pricingSchema = Schema.Struct({
	source: Schema.String,
	table_version: Schema.String,
	digest: Schema.String,
	effective_row_count: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
	cost_source: Schema.String,
	models: Schema.Record(Schema.String, pricingModelSchema),
});
const summarySchema = Schema.Struct({ pricing: pricingSchema });
const syncSchema = Schema.Struct({
	last_sync: Schema.String.check(Schema.isPattern(ISO_DATETIME_OFFSET_RE)),
});

function calendarDate(value: string, timezone: string, inclusiveEnd = false): string {
	const instant = new Date(inclusiveEnd ? Date.parse(value) - 1 : value);
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(instant);
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((item) => item.type === type)?.value ?? "";
	return `${part("year")}-${part("month")}-${part("day")}`;
}

function isLocalMidnight(value: string, timezone: string): boolean {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).formatToParts(new Date(value));
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((item) => item.type === type)?.value ?? "";
	return part("hour") === "00" && part("minute") === "00" && part("second") === "00";
}

export class CostMeterUnavailableError extends Error {}
export class CostMeterWindowError extends Error {}

export class AgentsViewCostMeter implements CostMeter {
	readonly #base: URL;
	readonly #hostHeader: string | null;
	readonly #token: string | null;
	readonly #timeoutMs: number;

	constructor(config: AgentsViewCostMeterConfig) {
		this.#base = new URL(config.url.endsWith("/") ? config.url : `${config.url}/`);
		this.#hostHeader = config.hostHeader ?? null;
		this.#token = config.token ?? null;
		this.#timeoutMs = config.timeoutMs ?? 10_000;
	}

	async #get(path: string, params?: URLSearchParams): Promise<unknown> {
		const url = new URL(path.replace(/^\//, ""), this.#base);
		if (params) url.search = params.toString();
		const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
		return await new Promise((resolve, reject) => {
			const request = transport(
				url,
				{
					headers: {
						accept: "application/json",
						...(this.#hostHeader ? { host: this.#hostHeader } : {}),
						...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
					},
					timeout: this.#timeoutMs,
				},
				(response) => {
					const chunks: Buffer[] = [];
					let bytes = 0;
					response.on("data", (chunk: Buffer) => {
						bytes += chunk.length;
						if (bytes > 2_000_000) {
							request.destroy(new Error("cost meter response exceeded 2 MB"));
							return;
						}
						chunks.push(chunk);
					});
					response.on("end", () => {
						const body = Buffer.concat(chunks).toString("utf8");
						if ((response.statusCode ?? 500) >= 400) {
							reject(new Error(`cost meter returned ${String(response.statusCode ?? 500)}`));
							return;
						}
						try {
							resolve(JSON.parse(body));
						} catch {
							reject(new Error("cost meter returned invalid JSON"));
						}
					});
				},
			);
			request.on("timeout", () => request.destroy(new Error("cost meter timed out")));
			request.on("error", reject);
			request.end();
		}).catch((error: unknown) => {
			throw new CostMeterUnavailableError(
				error instanceof Error ? error.message : "cost meter unavailable",
			);
		});
	}

	async compare(input: CostComparisonRequest): Promise<MeterComparison> {
		if (
			!(Date.parse(input.from) < Date.parse(input.to)) ||
			!isLocalMidnight(input.from, input.timezone) ||
			!isLocalMidnight(input.to, input.timezone)
		)
			throw new CostMeterWindowError(
				"AgentsView comparison requires an exact local-midnight ledger window",
			);
		const params = new URLSearchParams({
			left_dimension: input.dimension,
			left_value: input.left,
			right_dimension: input.dimension,
			right_value: input.right,
			from: calendarDate(input.from, input.timezone),
			to: calendarDate(input.to, input.timezone, true),
			timezone: input.timezone,
			breakdowns: "true",
			session_counts: "true",
		});
		const summaryParams = new URLSearchParams({
			from: required(params.get("from")),
			to: required(params.get("to")),
			timezone: input.timezone,
			breakdowns: "false",
			session_counts: "false",
		});
		const started = performance.now();
		const [rawPairwise, rawSummary, rawSync] = await Promise.all([
			this.#get("usage/pairwise-comparison", params),
			this.#get("usage/summary", summaryParams),
			this.#get("sync/status"),
		]);
		let pairwise: typeof pairwiseSchema.Type;
		let summary: typeof summarySchema.Type;
		let sync: typeof syncSchema.Type;
		try {
			pairwise = Schema.decodeUnknownSync(pairwiseSchema)(rawPairwise);
			summary = Schema.decodeUnknownSync(summarySchema)(rawSummary);
			sync = Schema.decodeUnknownSync(syncSchema)(rawSync);
		} catch (error) {
			throw new CostMeterUnavailableError(
				`cost meter returned an incomplete contract: ${error instanceof Error ? error.message : "invalid response"}`,
			);
		}
		return {
			left: pairwise.left,
			right: pairwise.right,
			pricing: summary.pricing,
			observedAt: sync.last_sync,
			query: JSON.stringify({
				comparison: `GET /usage/pairwise-comparison?${params.toString()}`,
				pricing: `GET /usage/summary?${summaryParams.toString()}`,
				freshness: "GET /sync/status",
			}),
			executionMs: Math.round(performance.now() - started),
			// This deployed endpoint is an exhaustive aggregate, not a paginated list. The strict side
			// contract and token-total invariant above are its completeness boundary.
			complete: true,
		};
	}
}
