import { asynchronously } from "#domain/iteration";
import { formatUnknown } from "#format";

import type { Sql } from "../db/pool.ts";
import {
	dryPlanStructured,
	prepareStructured,
	QueryError,
	runPreparedStructured,
	type QueryRequest,
	type QueryResult,
} from "../query/structured.ts";
import { materializePanel } from "../render/engine.ts";
import type { PanelSpecV2 } from "../render/types.ts";
import { searchSemanticCorpus, type SemanticSearchResult } from "../semantic/search.ts";
import { AssistantCompilerError, type AssistantCompiler } from "./compiler.ts";

export interface AskResult {
	schema_version: 1;
	status: "answered" | "refused";
	answer: string;
	panel: PanelSpecV2;
	result: QueryResult | null;
	shown_sql: { query_ref: string; sql: string; params: readonly unknown[] } | null;
	retrieval: { kind: string; source_ref: string; score: number }[];
	suggestions: string[];
	attempts: number;
}

function refusal(
	reason: string,
	suggestions: string[],
	context: readonly SemanticSearchResult[],
	attempts: number,
): AskResult {
	return {
		schema_version: 1,
		status: "refused",
		answer: reason,
		panel: {
			schema_version: 2,
			type: "refusal",
			title: "Unable to answer",
			refusal: { reason, suggestions },
		},
		result: null,
		shown_sql: null,
		retrieval: context.map(({ kind, source_ref, score }) => ({ kind, source_ref, score })),
		suggestions,
		attempts,
	};
}

function queryFeedback(error: unknown): { code: string; message: string } {
	if (error instanceof QueryError)
		return { code: error.code, message: error.message.slice(0, 300) };
	const code =
		error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
			? (error as { code: string }).code
			: "plan_rejected";
	return { code, message: "the structured intent could not be validated or executed safely" };
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function questionContainsLiteral(question: string, raw: unknown): boolean {
	if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") return false;
	const literal = String(raw).trim().toLocaleLowerCase();
	if (!literal) return false;
	const phrase = escapeRegex(literal);
	return new RegExp(`(^|[^a-z0-9_])${phrase}([^a-z0-9_]|$)`, "iu").test(
		question.toLocaleLowerCase(),
	);
}

function questionContainsLikePattern(question: string, raw: unknown): boolean {
	if (typeof raw !== "string") return false;
	const literals = raw.split(/[%_]+/).filter((value) => value.trim().length > 0);
	return literals.length > 0 && literals.every((value) => questionContainsLiteral(question, value));
}

function relativeTimeIsGrounded(question: string, value: string): boolean {
	const match = /^-([0-9]+)([smhd])$/.exec(value);
	if (!match) return false;
	const amount = match[1];
	const unit = { s: "seconds?", m: "minutes?", h: "hours?", d: "days?" }[
		match[2] as "s" | "m" | "h" | "d"
	];
	return new RegExp(
		`(?:last|past|previous|within)\\s+${escapeRegex(amount)}\\s*(?:${unit}|${escapeRegex(match[2])})\\b|\\b${escapeRegex(amount + match[2])}\\b`,
		"iu",
	).test(question);
}

function assertGroundedFilters(question: string, request: QueryRequest): void {
	for (const condition of Object.values(request.where ?? {})) {
		const operation =
			condition !== null && typeof condition === "object" && "op" in condition
				? (condition as { op?: unknown }).op
				: null;
		const raw =
			condition !== null && typeof condition === "object" && "value" in condition
				? (condition as { value?: unknown }).value
				: condition;
		const values = Array.isArray(raw) ? raw : [raw];
		for (const value of values) {
			if (value === null || value === undefined) continue;
			if (
				operation === "like"
					? !questionContainsLikePattern(question, value)
					: !questionContainsLiteral(question, value)
			)
				throw new QueryError(
					"ungrounded_filter",
					"filter values must be stated explicitly in the question",
				);
		}
	}
	for (const value of [request.time?.from, request.time?.to]) {
		if (
			value &&
			!questionContainsLiteral(question, value) &&
			!relativeTimeIsGrounded(question, value)
		)
			throw new QueryError(
				"ungrounded_filter",
				"time bounds must be stated explicitly in the question",
			);
	}
}

function assertRetrievedSource(
	context: readonly SemanticSearchResult[],
	request: QueryRequest,
): void {
	const sources = new Set(
		context
			.filter(({ kind }) => kind === "statistic" || kind === "view")
			.map(({ source_ref }) => source_ref),
	);
	if (!request.from || !sources.has(request.from))
		throw new QueryError(
			"source_not_retrieved",
			"the requested source was not present in retrieved semantic evidence",
		);
}

function groundedAnswer(result: QueryResult): string {
	if (result.row_count === 0) return "No matching data was found in the visible scopes.";
	if (result.row_count === 1 && result.columns.length === 1) {
		const name = result.columns[0]?.name ?? "value";
		return `${name.replaceAll("_", " ")}: ${formatUnknown(result.rows[0]?.[0] ?? "null")}.`;
	}
	const first = result.rows[0] ?? [];
	const preview = result.columns
		.slice(0, 3)
		.map(
			(column, index) =>
				`${column.name.replaceAll("_", " ")} ${formatUnknown(first[index] ?? "null")}`,
		)
		.join(", ");
	return `The query returned ${String(result.row_count)} row${result.row_count === 1 ? "" : "s"}${preview ? `; the first is ${preview}` : ""}.`;
}

export async function ask(
	db: { app: Sql; ro: Sql },
	compiler: AssistantCompiler,
	scopes: readonly string[],
	question: string,
): Promise<AskResult> {
	if (scopes.length === 0)
		return refusal(
			"No data scopes are available to answer this question.",
			["Request access to a relevant data scope."],
			[],
			0,
		);
	const context = await searchSemanticCorpus(db.app, scopes, question, 8);
	if (context.length === 0)
		return refusal(
			"No caller-visible semantic data matches this question.",
			["Ask about a statistic available in the catalog."],
			context,
			0,
		);
	let feedback: { code: string; message: string } | undefined;
	for await (const attempt of asynchronously([1, 2])) {
		try {
			const proposal = await compiler.compile({
				question,
				context,
				...(feedback ? { feedback } : {}),
			});
			if (!proposal.feasible)
				return refusal(
					proposal.reason ?? "The question is not feasible.",
					proposal.suggestions ?? [],
					context,
					attempt,
				);
			const request = proposal.request as QueryRequest;
			assertRetrievedSource(context, request);
			assertGroundedFilters(question, request);
			const prepared = await prepareStructured(db.app, scopes, request);
			await dryPlanStructured(db.ro, scopes, prepared);
			const result = await runPreparedStructured(db.app, db.ro, scopes, prepared);
			const answer = groundedAnswer(result);
			const materialized = materializePanel(
				{
					schema_version: 2,
					type: "table",
					title: proposal.panel?.title ?? "Analysis",
					description: proposal.panel?.description ?? null,
					query_ref: result.query_ref,
					encoding: proposal.panel?.encoding ?? {},
					suggestions: proposal.suggestions ?? [],
				},
				result,
			);
			const panel = materialized.panel;
			panel.narrative = answer;
			return {
				schema_version: 1,
				status: "answered",
				answer,
				panel,
				result,
				shown_sql: { query_ref: result.query_ref, sql: prepared.sqlText, params: prepared.params },
				retrieval: context.map(({ kind, source_ref, score }) => ({ kind, source_ref, score })),
				suggestions: proposal.suggestions ?? [],
				attempts: attempt,
			};
		} catch (error) {
			if (error instanceof QueryError) {
				feedback = queryFeedback(error);
				continue;
			}
			if (error instanceof AssistantCompilerError && attempt === 1) {
				feedback = { code: "compile_rejected", message: "return a valid structured intent" };
				continue;
			}
			throw error;
		}
	}
	return refusal(
		"The requested analysis could not be validated safely.",
		["Try a narrower question using fields shown in the catalog."],
		context,
		2,
	);
}
