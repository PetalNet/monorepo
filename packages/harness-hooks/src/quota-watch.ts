// Quota threshold checker, formatting, and per-limit per-reset-window alert deduplication.
//
// Each watched limit is checked against sorted percentage thresholds (default: 88%, 98%).
// When a limit crosses a threshold for the first time in its current reset window, one prompt
// is queued into Janet's Claude Code session through `cc-link-inject --source quota-watch --key ...`,
// and the state file records the alerted threshold for that window so later ticks do not repeat it.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { QuotaLimit, ServiceName, ServiceReport, SourceConfig } from "./quota-sources.ts";
import { defaultSourceDeps, readAllServices, sourceConfigFromEnv } from "./quota-sources.ts";

export const DEFAULT_THRESHOLDS = [88, 98] as const;
export const WINDOW_TOLERANCE_MS = 30 * 60_000;

export interface WatchConfig {
	stateFile: string;
	injectCommand: string;
	thresholds: number[];
	source: SourceConfig;
}

export interface RecordedLimitState {
	windowId: string;
	resetAtMs?: number | undefined;
	alertedThreshold: number;
	alertedAt: string;
	alertedPct: number;
}

export interface WatchState {
	version: 1;
	limits: Record<string, RecordedLimitState>;
}

export interface InjectResult {
	ok: boolean;
	output: string;
}

export interface WatchDeps {
	now: () => number;
	readServices: () => Promise<ServiceReport[]>;
	inject: (prompt: string, source: string, key: string) => InjectResult;
	stateExists: (filePath: string) => boolean;
	loadState: (filePath: string) => WatchState;
	saveState: (filePath: string, state: WatchState) => void;
}

export interface ThresholdCrossing {
	service: ServiceName;
	limitId: string;
	label: string;
	threshold: number;
	usedPct: number;
	windowId: string;
	injectKey: string;
	prompt: string;
}

export interface CheckResult {
	checkedAt: string;
	services: ServiceReport[];
	crossed: ThresholdCrossing[];
	injected: ThresholdCrossing[];
	sourceErrors: string[];
	injectErrors: string[];
}

function envOr(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
	const value = env[name];

	return value === undefined || value === "" ? fallback : value;
}

function parseThresholds(raw: string | undefined): number[] {
	if (!raw || raw.trim() === "") {
		return [...DEFAULT_THRESHOLDS];
	}

	const parsed = raw
		.split(",")
		.map((part) => Number(part.trim()))
		.filter((n) => Number.isFinite(n) && n > 0 && n <= 100);

	if (parsed.length === 0) {
		return [...DEFAULT_THRESHOLDS];
	}

	return [...new Set(parsed)].toSorted((a, b) => a - b);
}

/** Reads watcher configuration from environment variables with lab defaults. */
export function watchConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WatchConfig {
	const home = env["HOME"] ?? "";
	const hermes = envOr(env, "HERMES_HOME", `${home}/.hermes-janet`);

	return {
		stateFile: envOr(env, "QUOTA_STATE_FILE", `${home}/.local/share/quota-watch/state.json`),
		injectCommand: envOr(
			env,
			"QUOTA_INJECT",
			`${hermes}/plugins/hermes-cc-link/bin/cc-link-inject`,
		),
		thresholds: parseThresholds(env["QUOTA_THRESHOLDS"]),
		source: sourceConfigFromEnv(env),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Loads persisted alert state from disk, returning an empty state when the file does not exist yet. */
export function loadState(filePath: string): WatchState {
	if (!existsSync(filePath)) {
		return { version: 1, limits: {} };
	}

	const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));

	if (!isRecord(parsed) || !isRecord(parsed["limits"])) {
		throw new Error(`invalid quota state file: ${filePath}`);
	}

	const limits: Record<string, RecordedLimitState> = {};

	for (const [id, entry] of Object.entries(parsed["limits"])) {
		if (!isRecord(entry)) {
			continue;
		}

		const windowId = entry["windowId"];
		const alertedThreshold = entry["alertedThreshold"];
		const alertedAt = entry["alertedAt"];
		const alertedPct = entry["alertedPct"];
		const resetAtMs = entry["resetAtMs"];

		if (
			typeof windowId !== "string" ||
			typeof alertedThreshold !== "number" ||
			typeof alertedAt !== "string" ||
			typeof alertedPct !== "number"
		) {
			continue;
		}

		limits[id] = {
			windowId,
			resetAtMs:
				typeof resetAtMs === "number" && Number.isFinite(resetAtMs) ? resetAtMs : undefined,
			alertedThreshold,
			alertedAt,
			alertedPct,
		};
	}

	return { version: 1, limits };
}

/** Atomically writes watcher state to disk. */
export function saveState(filePath: string, state: WatchState): void {
	mkdirSync(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.tmp.${String(process.pid)}.${String(Date.now())}`;

	writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	renameSync(tmp, filePath);
}

function runInject(
	injectCommand: string,
	prompt: string,
	source: string,
	key: string,
): InjectResult {
	const result = spawnSync(injectCommand, ["--source", source, "--key", key], {
		input: prompt,
		encoding: "utf8",
		timeout: 30_000,
	});
	const output = `${result.stdout}${result.stderr}`.trim() || (result.error?.message ?? "");

	return { ok: result.status === 0, output };
}

/** Real runtime dependencies for `quota check`. */
export function watchDepsFromEnv(config: WatchConfig): WatchDeps {
	const sourceDeps = defaultSourceDeps();

	return {
		now: () => Date.now(),
		readServices: () => readAllServices(config.source, sourceDeps),
		inject: (prompt, source, key) => runInject(config.injectCommand, prompt, source, key),
		stateExists: (filePath) => existsSync(filePath),
		loadState,
		saveState,
	};
}

/**
 * Checks whether a live limit observation belongs to the same reset window as a recorded alert.
 * Uses a 30-minute tolerance on parsed reset timestamps to absorb minor API clock jitter.
 */
export function isSameWindow(recorded: RecordedLimitState, limit: QuotaLimit): boolean {
	if (recorded.windowId === limit.windowId) {
		return true;
	}

	if (recorded.resetAtMs !== undefined && limit.resetAtMs !== undefined) {
		return Math.abs(recorded.resetAtMs - limit.resetAtMs) <= WINDOW_TOLERANCE_MS;
	}

	return false;
}

/** Returns the highest threshold reached by `usedPct`, or `undefined` if below all thresholds. */
export function highestCrossedThreshold(
	usedPct: number,
	thresholds: readonly number[],
): number | undefined {
	let highest: number | undefined;

	for (const threshold of thresholds) {
		if (usedPct >= threshold && (highest === undefined || threshold > highest)) {
			highest = threshold;
		}
	}

	return highest;
}

function fmtPct(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** Formats the session prompt injected into Janet's Claude Code session on a threshold crossing. */
export function formatAlertPrompt(
	service: ServiceName,
	limit: QuotaLimit,
	threshold: number,
): string {
	const severity = threshold >= 98 ? "CRITICAL: " : "";
	const detail = limit.detail ? `, ${limit.detail}` : "";
	const reset = limit.resetLabel ? `, resets ${limit.resetLabel}` : "";
	const action =
		threshold >= 98
			? "Run `quota` for all services, pause heavy work on this service, or ask Parker about a reset/limit."
			: "Run `quota` for all services and throttle or shift work off this service if needed.";

	return `[quota-watch] ${severity}${limit.label} (${service}) crossed ${String(threshold)}% used (${fmtPct(limit.usedPct)}%${detail}${reset}). ${action}`;
}

const SERVICE_LABEL_WIDTH = 15;

/** Formats one service report as a single aligned terminal line. */
export function formatServiceLine(report: ServiceReport): string {
	const name = report.service.padEnd(SERVICE_LABEL_WIDTH);

	if (report.status === "error") {
		return `${name} error: ${report.error ?? report.summary}`;
	}

	return `${name} ${report.summary}`;
}

/** Formats all service reports, one line per service. */
export function formatReport(reports: readonly ServiceReport[]): string {
	return reports.map(formatServiceLine).join("\n");
}

/**
 * Evaluates all services against thresholds, injects once per limit per reset window, and persists
 * updated state. When `dryRun` is true, evaluates crossings without injecting or writing state.
 */
export async function runCheck(
	config: WatchConfig,
	deps: WatchDeps,
	options: { dryRun?: boolean } = {},
): Promise<CheckResult> {
	const dryRun = options.dryRun ?? false;
	const checkedAt = new Date(deps.now()).toISOString();
	const stateExisted = deps.stateExists(config.stateFile);
	const state = deps.loadState(config.stateFile);
	const nextLimits = new Map<string, RecordedLimitState>(Object.entries(state.limits));
	let stateChanged = false;

	const services = await deps.readServices();
	const crossed: ThresholdCrossing[] = [];
	const injected: ThresholdCrossing[] = [];
	const sourceErrors: string[] = [];
	const injectErrors: string[] = [];

	for (const report of services) {
		if (report.status === "error") {
			sourceErrors.push(`${report.service}: ${report.error ?? report.summary}`);

			continue;
		}

		if (report.status !== "ok") {
			continue;
		}

		for (const limit of report.limits) {
			const prev = nextLimits.get(limit.id);
			const same = prev !== undefined && isSameWindow(prev, limit);

			if (prev !== undefined && !same) {
				nextLimits.delete(limit.id);
				stateChanged = true;
			}

			const alreadyAlerted = same ? prev.alertedThreshold : 0;
			const threshold = highestCrossedThreshold(limit.usedPct, config.thresholds);

			if (threshold === undefined || threshold <= alreadyAlerted) {
				continue;
			}

			const windowId = same ? prev.windowId : limit.windowId;
			const injectKey = `quota:${limit.id}:${String(threshold)}:${windowId}`;
			const prompt = formatAlertPrompt(report.service, limit, threshold);
			const crossing: ThresholdCrossing = {
				service: report.service,
				limitId: limit.id,
				label: limit.label,
				threshold,
				usedPct: limit.usedPct,
				windowId,
				injectKey,
				prompt,
			};

			crossed.push(crossing);

			if (dryRun) {
				continue;
			}

			const res = deps.inject(prompt, "quota-watch", injectKey);

			if (res.ok) {
				injected.push(crossing);

				nextLimits.set(limit.id, {
					windowId,
					resetAtMs: limit.resetAtMs,
					alertedThreshold: threshold,
					alertedAt: checkedAt,
					alertedPct: limit.usedPct,
				});

				stateChanged = true;
			} else {
				injectErrors.push(
					`${limit.id} (${String(threshold)}%): ${res.output || "cc-link-inject failed"}`,
				);
			}
		}
	}

	if (!dryRun && (stateChanged || !stateExisted)) {
		deps.saveState(config.stateFile, {
			version: 1,
			limits: Object.fromEntries(nextLimits),
		});
	}

	return {
		checkedAt,
		services,
		crossed,
		injected,
		sourceErrors,
		injectErrors,
	};
}
