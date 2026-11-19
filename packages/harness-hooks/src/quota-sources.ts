// Quota source readers and parsers for every limited service the lab uses:
//   claude         ~/.claude/bin/usage (--json with plain-text fallback)
//   google-ai      agy -p /quota (remaining % inverted to % used)
//   codex          codex login status (+ latest ~/.codex/sessions rollout when signed in)
//   cloudflare-ai  Workers AI daily neurons via GraphQL (token from `vault get cf-janet-full-token`)
//   github-actions PetalNet org monthly private-repo Actions minutes (token from shared/github-pat)
//   tmobile        1.2 TB cycle + priority-week meter from dot14 ~/.claude/state/data-budget.json
//
// Tokens are read once per call, passed directly in Authorization headers, and never printed or returned.
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export type ServiceName =
	| "claude"
	| "google-ai"
	| "codex"
	| "cloudflare-ai"
	| "github-actions"
	| "tmobile";

export interface QuotaLimit {
	/** Stable identifier, e.g. "claude:7d" or "cloudflare-ai:daily". */
	id: string;
	/** Human-readable label shown in alerts. */
	label: string;
	/** Percentage used (0-100+; may exceed 100 when over a soft/free allocation). */
	usedPct: number;
	/** Identifier of the current reset window. */
	windowId: string;
	/** Parsed reset time in epoch milliseconds when available. */
	resetAtMs?: number | undefined;
	/** Short human-readable reset time. */
	resetLabel?: string | undefined;
	/** Optional concrete usage quantities for alert messages. */
	detail?: string | undefined;
}

export interface ServiceReport {
	service: ServiceName;
	status: "ok" | "signed-out" | "error";
	summary: string;
	limits: QuotaLimit[];
	error?: string | undefined;
}

export interface SourceConfig {
	timeZone: string;
	claudeUsageCmd: string;
	agyCmd: string;
	codexCmd: string;
	codexSessionsDir: string;
	vaultCmd: string;
	cfVaultKey: string;
	cfAccountId: string;
	cfDailyNeurons: number;
	cfGraphqlUrl: string;
	githubOrg: string;
	githubTokenFile: string;
	githubApiUrl: string;
	githubActionsLimit?: number | undefined;
	tmobileFile?: string | undefined;
	tmobileSshHost: string;
	tmobileRemotePath: string;
}

export interface CommandOutput {
	code: number | null;
	stdout: string;
	stderr: string;
	error?: string | undefined;
}

export interface HttpResponse {
	status: number;
	ok: boolean;
	text: string;
}

export interface SourceDeps {
	now: () => number;
	exec: (command: string, args: string[], timeoutMs: number) => Promise<CommandOutput>;
	http: (
		url: string,
		init: {
			method?: string | undefined;
			headers?: Record<string, string> | undefined;
			body?: string | undefined;
			timeoutMs?: number | undefined;
		},
	) => Promise<HttpResponse>;
	readFile: (filePath: string) => string;
}

const DEFAULT_CF_ACCOUNT_ID = "a698a2e9f1c32fda33b0f75d542ec4a5";
const DEFAULT_CF_DAILY_NEURONS = 10_000;
const CLAUDE_STALE_SECONDS = 900;
const TMOBILE_STALE_MS = 60 * 60_000;
const WINDOW_BUCKET_MS = 30 * 60_000;

const TZ_OFFSETS: Record<string, string> = {
	UTC: "+00:00",
	GMT: "+00:00",
	EST: "-05:00",
	EDT: "-04:00",
	CST: "-06:00",
	CDT: "-05:00",
	MST: "-07:00",
	MDT: "-06:00",
	PST: "-08:00",
	PDT: "-07:00",
};

const PLAN_INCLUDED_MINUTES: Record<string, number> = {
	free: 2_000,
	team: 3_000,
	pro: 3_000,
	enterprise: 50_000,
};

function envOr(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
	const value = env[name];

	return value === undefined || value === "" ? fallback : value;
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
	const raw = env[name];

	if (raw === undefined || raw === "") {
		return fallback;
	}

	const parsed = Number(raw);

	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Reads quota source configuration from environment variables with lab defaults. */
export function sourceConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SourceConfig {
	const home = env["HOME"] ?? "";
	const ghLimitRaw = env["QUOTA_GITHUB_ACTIONS_LIMIT"];
	const ghLimitParsed = ghLimitRaw ? Number(ghLimitRaw) : Number.NaN;
	const tmobileFile = env["QUOTA_TMOBILE_FILE"];

	return {
		timeZone: envOr(env, "QUOTA_TZ", "America/Chicago"),
		claudeUsageCmd: envOr(env, "QUOTA_CLAUDE_USAGE_CMD", `${home}/.claude/bin/usage`),
		agyCmd: envOr(env, "QUOTA_AGY_CMD", "agy"),
		codexCmd: envOr(env, "QUOTA_CODEX_CMD", "codex"),
		codexSessionsDir: envOr(env, "QUOTA_CODEX_SESSIONS_DIR", `${home}/.codex/sessions`),
		vaultCmd: envOr(env, "QUOTA_VAULT_CMD", "vault"),
		cfVaultKey: envOr(env, "QUOTA_CF_VAULT_KEY", "cf-janet-full-token"),
		cfAccountId: envOr(env, "QUOTA_CF_ACCOUNT_ID", DEFAULT_CF_ACCOUNT_ID),
		cfDailyNeurons: envInt(env, "QUOTA_CF_DAILY_NEURONS", DEFAULT_CF_DAILY_NEURONS),
		cfGraphqlUrl: envOr(
			env,
			"QUOTA_CF_GRAPHQL_URL",
			"https://api.cloudflare.com/client/v4/graphql",
		),
		githubOrg: envOr(env, "QUOTA_GITHUB_ORG", "PetalNet"),
		githubTokenFile: envOr(env, "QUOTA_GITHUB_TOKEN_FILE", `${home}/.claude/shared/github-pat`),
		githubApiUrl: envOr(env, "QUOTA_GITHUB_API_URL", "https://api.github.com"),
		githubActionsLimit:
			Number.isFinite(ghLimitParsed) && ghLimitParsed > 0 ? ghLimitParsed : undefined,
		tmobileFile: tmobileFile && tmobileFile !== "" ? tmobileFile : undefined,
		tmobileSshHost: envOr(env, "QUOTA_TMOBILE_SSH_HOST", "dot14"),
		tmobileRemotePath: envOr(env, "QUOTA_TMOBILE_REMOTE_PATH", "~/.claude/state/data-budget.json"),
	};
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<CommandOutput> {
	return new Promise((resolve) => {
		execFile(
			command,
			args,
			{ encoding: "utf8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, killSignal: "SIGTERM" },
			(err, stdout, stderr) => {
				if (!err) {
					resolve({ code: 0, stdout, stderr });

					return;
				}

				const exitCode = typeof err.code === "number" ? err.code : null;

				resolve({
					code: exitCode,
					stdout,
					stderr,
					error: err.killed ? `timed out after ${String(timeoutMs)}ms` : err.message,
				});
			},
		);
	});
}

async function runHttp(
	url: string,
	init: {
		method?: string | undefined;
		headers?: Record<string, string> | undefined;
		body?: string | undefined;
		timeoutMs?: number | undefined;
	},
): Promise<HttpResponse> {
	const reqInit: RequestInit = {
		method: init.method ?? "GET",
		signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
	};

	if (init.headers !== undefined) {
		reqInit.headers = init.headers;
	}

	if (init.body !== undefined) {
		reqInit.body = init.body;
	}

	const response = await fetch(url, reqInit);
	const text = await response.text();

	return { status: response.status, ok: response.ok, text };
}

/** Real runtime dependencies for reading every quota source. */
export function defaultSourceDeps(): SourceDeps {
	return {
		now: () => Date.now(),
		exec: runCommand,
		http: runHttp,
		readFile: (filePath) => readFileSync(filePath, "utf8"),
	};
}

function slug(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, "-")
		.replace(/^-+|-+$/gu, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function fmtInt(value: number): string {
	return Math.round(value).toLocaleString("en-US");
}

function fmtPct(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function utcDateKey(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

function bucketWindowId(resetAtMs: number): string {
	const rounded = Math.round(resetAtMs / WINDOW_BUCKET_MS) * WINDOW_BUCKET_MS;

	return `${new Date(rounded).toISOString().slice(0, 16)}Z`;
}

function formatResetShort(ms: number, timeZone: string): string {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(new Date(ms));
	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

	return `${get("month")} ${get("day")} ${get("hour")}:${get("minute")}`;
}

function formatDateShort(ms: number, timeZone: string): string {
	return new Intl.DateTimeFormat("en-US", {
		timeZone,
		month: "short",
		day: "numeric",
	}).format(new Date(ms));
}

function parseIsoMs(text: string | undefined): number | undefined {
	if (!text) {
		return undefined;
	}

	const ms = Date.parse(text);

	return Number.isNaN(ms) ? undefined : ms;
}

/** Parses `YYYY-MM-DD HH:MM TZ` (as printed by `agy -p /quota`) or ISO timestamps into epoch ms. */
export function parseResetTimestamp(text: string | undefined): number | undefined {
	if (!text) {
		return undefined;
	}

	const trimmed = text.trim();

	if (!trimmed || /^n\/a$/iu.test(trimmed)) {
		return undefined;
	}

	const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?(?:\s+([A-Z]{2,5}))?$/u.exec(
		trimmed,
	);

	if (match) {
		const datePart = match[1] ?? "";
		const hmPart = match[2] ?? "";
		const secPart = match[3] ?? "00";
		const tz = match[4];
		const offset = tz ? TZ_OFFSETS[tz] : undefined;

		if (offset) {
			return parseIsoMs(`${datePart}T${hmPart}:${secPart}${offset}`);
		}
	}

	return parseIsoMs(trimmed);
}

// --- 1. Claude (~/.claude/bin/usage) ---

/** Parses JSON output from `~/.claude/bin/usage --json`. */
export function parseClaudeUsageJson(text: string, nowMs: number, timeZone: string): ServiceReport {
	let parsed: unknown;

	try {
		parsed = JSON.parse(text);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);

		return {
			service: "claude",
			status: "error",
			summary: `invalid json: ${msg}`,
			limits: [],
			error: `invalid json: ${msg}`,
		};
	}

	if (!isRecord(parsed)) {
		return {
			service: "claude",
			status: "error",
			summary: "unexpected usage payload",
			limits: [],
			error: "unexpected usage payload",
		};
	}

	const limits: QuotaLimit[] = [];
	const parts: string[] = [];

	const fivePct = asNumber(parsed["five_hour_pct"]);
	const fiveResetSec = asNumber(parsed["five_hour_resets_at"]) ?? 0;
	const fiveResetIso = asString(parsed["five_hour_resets_at_iso"]);
	const fiveResetMs =
		parseIsoMs(fiveResetIso) ?? (fiveResetSec > 0 ? fiveResetSec * 1_000 : undefined);

	if (fivePct !== undefined && (fiveResetMs !== undefined || fivePct > 0)) {
		const resetLabel =
			fiveResetMs === undefined ? undefined : formatResetShort(fiveResetMs, timeZone);

		limits.push({
			id: "claude:5h",
			label: "Claude 5h",
			usedPct: fivePct,
			windowId: fiveResetMs === undefined ? `5h:${utcDateKey(nowMs)}` : bucketWindowId(fiveResetMs),
			resetAtMs: fiveResetMs,
			resetLabel,
		});

		parts.push(
			resetLabel ? `5h ${fmtPct(fivePct)}% (resets ${resetLabel})` : `5h ${fmtPct(fivePct)}%`,
		);
	} else {
		parts.push("5h idle");
	}

	const sevenPct = asNumber(parsed["seven_day_pct"]);
	const sevenResetIso = asString(parsed["seven_day_resets_at_iso"]);
	const sevenResetMs = parseIsoMs(sevenResetIso);
	const sevenResetLabel =
		sevenResetMs === undefined ? undefined : formatResetShort(sevenResetMs, timeZone);

	if (sevenPct !== undefined) {
		limits.push({
			id: "claude:7d",
			label: "Claude 7d",
			usedPct: sevenPct,
			windowId:
				sevenResetMs === undefined ? `7d:${utcDateKey(nowMs)}` : bucketWindowId(sevenResetMs),
			resetAtMs: sevenResetMs,
			resetLabel: sevenResetLabel,
		});

		parts.push(`7d ${fmtPct(sevenPct)}%`);
	}

	const raw = isRecord(parsed["raw"]) ? parsed["raw"] : undefined;
	const rawLimits = raw && Array.isArray(raw["limits"]) ? raw["limits"] : [];

	for (const entry of rawLimits) {
		if (!isRecord(entry) || asString(entry["kind"]) !== "weekly_scoped") {
			continue;
		}

		const pct = asNumber(entry["percent"]);

		if (pct === undefined) {
			continue;
		}

		const scope = isRecord(entry["scope"]) ? entry["scope"] : undefined;
		const model = scope && isRecord(scope["model"]) ? scope["model"] : undefined;
		const name = asString(model?.["display_name"]) ?? asString(scope?.["surface"]) ?? "scoped";
		const scopedResetMs = parseIsoMs(asString(entry["resets_at"])) ?? sevenResetMs;
		const scopedResetLabel =
			scopedResetMs === undefined ? sevenResetLabel : formatResetShort(scopedResetMs, timeZone);

		limits.push({
			id: `claude:${slug(name)}`,
			label: `Claude ${name}`,
			usedPct: pct,
			windowId:
				scopedResetMs === undefined ? `scoped:${utcDateKey(nowMs)}` : bucketWindowId(scopedResetMs),
			resetAtMs: scopedResetMs,
			resetLabel: scopedResetLabel,
		});

		parts.push(`${name} ${fmtPct(pct)}%`);
	}

	if (sevenResetLabel) {
		parts.push(`resets ${sevenResetLabel}`);
	}

	const scrapedSec = asNumber(parsed["scraped_at"]);

	if (scrapedSec !== undefined) {
		const ageSec = Math.floor(nowMs / 1_000) - scrapedSec;

		if (ageSec > CLAUDE_STALE_SECONDS) {
			parts.push(`stale ${String(Math.floor(ageSec / 60))}m`);
		}
	}

	return {
		service: "claude",
		status: "ok",
		summary: parts.join(" · "),
		limits,
	};
}

/** Parses plain-text output from `~/.claude/bin/usage` ("5h … · 7d N% · Fable N%"). */
export function parseClaudeUsageText(text: string, nowMs: number): ServiceReport {
	const line = text.trim().split(/\r?\n/u)[0]?.trim() ?? "";

	if (!line) {
		return {
			service: "claude",
			status: "error",
			summary: "empty output from usage",
			limits: [],
			error: "empty output from usage",
		};
	}

	const limits: QuotaLimit[] = [];
	const segments = line
		.split("·")
		.map((s) => s.trim())
		.filter(Boolean);
	const dayKey = utcDateKey(nowMs);

	for (const seg of segments) {
		if (/\b5h\s+idle\b/iu.test(seg)) {
			continue;
		}

		const sevenMatch = /\b7d\s+(\d+(?:\.\d+)?)%/iu.exec(seg);

		if (sevenMatch) {
			limits.push({
				id: "claude:7d",
				label: "Claude 7d",
				usedPct: Number(sevenMatch[1]),
				windowId: `7d:${dayKey}`,
			});

			continue;
		}

		const fiveMatch = /(?:^|[^\w])(?:5h\s+)?(\d+(?:\.\d+)?)%$/u.exec(seg);

		if (fiveMatch && !/[a-z]{3,}/iu.test(seg.replace(/5h/iu, ""))) {
			limits.push({
				id: "claude:5h",
				label: "Claude 5h",
				usedPct: Number(fiveMatch[1]),
				windowId: `5h:${dayKey}`,
			});

			continue;
		}

		const scopedMatch = /^([A-Za-z][A-Za-z0-9 _-]*?)\s+(\d+(?:\.\d+)?)%$/u.exec(seg);

		if (scopedMatch) {
			const name = scopedMatch[1]?.trim() ?? "scoped";

			limits.push({
				id: `claude:${slug(name)}`,
				label: `Claude ${name}`,
				usedPct: Number(scopedMatch[2]),
				windowId: `scoped:${dayKey}`,
			});
		}
	}

	if (limits.length === 0 && !/\b5h\s+idle\b/iu.test(line)) {
		return {
			service: "claude",
			status: "error",
			summary: `could not parse usage: ${line}`,
			limits: [],
			error: `could not parse usage: ${line}`,
		};
	}

	const cleaned = line.replace(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}\s]+/u, "").trim();

	return {
		service: "claude",
		status: "ok",
		summary: cleaned || line,
		limits,
	};
}

/** Reads Claude quota via `~/.claude/bin/usage --json` (falling back to plain text). */
export async function readClaude(config: SourceConfig, deps: SourceDeps): Promise<ServiceReport> {
	const result = await deps.exec(config.claudeUsageCmd, ["--json"], 15_000);

	if (result.code !== 0) {
		const errText = result.stderr.trim();
		const msg = errText === "" ? (result.error ?? `exit ${String(result.code)}`) : errText;

		return {
			service: "claude",
			status: "error",
			summary: msg,
			limits: [],
			error: msg,
		};
	}

	const trimmed = result.stdout.trim();

	if (trimmed.startsWith("{")) {
		return parseClaudeUsageJson(trimmed, deps.now(), config.timeZone);
	}

	return parseClaudeUsageText(trimmed, deps.now());
}

// --- 2. Google AI plan (agy -p /quota) ---

const ANSI_RE = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;]*[a-zA-Z]`, "gu");

/** Parses `agy -p /quota` (both TSV non-TTY and aligned TTY tables) into % used limits. */
export function parseAgyQuota(
	text: string,
	nowMs: number,
	timeZone = "America/Chicago",
): ServiceReport {
	const cleaned = text.replace(ANSI_RE, "");
	const lines = cleaned.split(/\r?\n/u);
	const limits: QuotaLimit[] = [];
	const poolSummary = new Map<string, string[]>();

	for (const rawLine of lines) {
		const line = rawLine.trim();

		if (!line || /^quota:?$/iu.test(line)) {
			continue;
		}

		const cols = line.includes("\t")
			? line.split("\t").map((c) => c.trim())
			: line.split(/\s{2,}/u).map((c) => c.trim());

		if (cols.length < 3) {
			continue;
		}

		const pool = cols[0] ?? "";
		const windowDesc = cols[1] ?? "";
		const pctMatch = /^(\d+(?:\.\d+)?)%$/u.exec(cols[2] ?? "");
		const resetText = cols[3];

		if (!pool || !pctMatch) {
			continue;
		}

		const remainingPct = Number(pctMatch[1]);

		if (!Number.isFinite(remainingPct)) {
			continue;
		}

		const usedPct = Math.max(0, Math.min(100, Math.round((100 - remainingPct) * 10) / 10));
		const windowTag = /five\s*hour|5h/iu.test(windowDesc)
			? "5h"
			: /weekly|7d/iu.test(windowDesc)
				? "7d"
				: slug(windowDesc);
		const resetAtMs = parseResetTimestamp(resetText);
		const windowId =
			resetAtMs === undefined ? `${windowTag}:${utcDateKey(nowMs)}` : bucketWindowId(resetAtMs);
		const fallbackReset = resetText === "" ? undefined : resetText;
		const resetLabel =
			resetAtMs === undefined ? fallbackReset : formatResetShort(resetAtMs, timeZone);

		limits.push({
			id: `google-ai:${slug(pool)}:${windowTag}`,
			label: `Google AI ${pool} ${windowTag}`,
			usedPct,
			windowId,
			resetAtMs,
			resetLabel,
			detail: `${fmtPct(remainingPct)}% remaining`,
		});

		const existing = poolSummary.get(pool) ?? [];

		existing.push(`${windowTag} ${fmtPct(usedPct)}%`);
		poolSummary.set(pool, existing);
	}

	if (limits.length === 0) {
		const snippet = cleaned.trim().split(/\r?\n/u)[0] ?? "empty output";

		return {
			service: "google-ai",
			status: "error",
			summary: `no quota rows parsed (${snippet})`,
			limits: [],
			error: `no quota rows parsed (${snippet})`,
		};
	}

	const summaryParts: string[] = [];

	for (const [pool, entries] of poolSummary) {
		summaryParts.push(`${pool} ${entries.join(" / ")}`);
	}

	return {
		service: "google-ai",
		status: "ok",
		summary: `${summaryParts.join(" · ")} (used)`,
		limits,
	};
}

/** Reads Google AI plan pools via `agy -p /quota`. */
export async function readGoogleAi(config: SourceConfig, deps: SourceDeps): Promise<ServiceReport> {
	const result = await deps.exec(config.agyCmd, ["-p", "/quota"], 25_000);

	if (result.code !== 0) {
		const errText = result.stderr.trim();
		const msg = errText === "" ? (result.error ?? `exit ${String(result.code)}`) : errText;

		return {
			service: "google-ai",
			status: "error",
			summary: msg,
			limits: [],
			error: msg,
		};
	}

	return parseAgyQuota(result.stdout, deps.now(), config.timeZone);
}

// --- 3. Codex (codex login status + optional session rate limits) ---

/** Interprets `codex login status` output. */
export function parseCodexLoginStatus(
	code: number | null,
	stdout: string,
	stderr: string,
): { signedIn: boolean; detail: string } {
	const combined = `${stdout}\n${stderr}`.trim();

	if (code !== 0 || /\b(not logged in|signed out|logged out)\b/iu.test(combined)) {
		return { signedIn: false, detail: combined || "signed out" };
	}

	return { signedIn: true, detail: combined || "signed in" };
}

/** Parses OpenAI Codex session `rate_limits` snapshot (`primary` 5h, `secondary` 7d). */
export function parseCodexRateLimits(raw: unknown, nowMs: number, timeZone: string): ServiceReport {
	if (!isRecord(raw)) {
		return {
			service: "codex",
			status: "ok",
			summary: "signed in (no usage snapshot yet)",
			limits: [],
		};
	}

	const limits: QuotaLimit[] = [];
	const parts: string[] = [];
	const windows: [string, string, string][] = [
		["primary", "codex:5h", "5h"],
		["secondary", "codex:7d", "7d"],
	];

	for (const [field, id, short] of windows) {
		const entry = isRecord(raw[field]) ? raw[field] : undefined;
		const pct = asNumber(entry?.["used_percent"]);

		if (pct === undefined) {
			continue;
		}

		const resetSec = asNumber(entry?.["resets_at"]);
		const resetAtMs = resetSec === undefined ? undefined : resetSec * 1_000;

		if (resetAtMs !== undefined && resetAtMs <= nowMs) {
			parts.push(`${short} 0% (reset)`);

			continue;
		}

		const resetLabel = resetAtMs === undefined ? undefined : formatResetShort(resetAtMs, timeZone);

		limits.push({
			id,
			label: `Codex ${short}`,
			usedPct: pct,
			windowId:
				resetAtMs === undefined ? `${short}:${utcDateKey(nowMs)}` : bucketWindowId(resetAtMs),
			resetAtMs,
			resetLabel,
		});

		parts.push(
			resetLabel ? `${short} ${fmtPct(pct)}% (resets ${resetLabel})` : `${short} ${fmtPct(pct)}%`,
		);
	}

	return {
		service: "codex",
		status: "ok",
		summary: parts.length > 0 ? parts.join(" · ") : "signed in (no usage snapshot yet)",
		limits,
	};
}

function findLatestCodexRateLimits(sessionsDir: string, readFile: (p: string) => string): unknown {
	const files: { filePath: string; mtimeMs: number }[] = [];

	function walk(dir: string) {
		let entries;

		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			const full = path.join(dir, entry.name);

			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				try {
					files.push({ filePath: full, mtimeMs: statSync(full).mtimeMs });
				} catch {
					// Skip unreadable file.
				}
			}
		}
	}

	walk(sessionsDir);
	files.sort((a, b) => b.mtimeMs - a.mtimeMs);

	function findRateLimits(node: unknown): unknown {
		if (!isRecord(node)) {
			if (Array.isArray(node)) {
				for (const item of node) {
					const hit = findRateLimits(item);

					if (hit !== undefined) {
						return hit;
					}
				}
			}

			return undefined;
		}

		if (isRecord(node["rate_limits"])) {
			return node["rate_limits"];
		}

		for (const value of Object.values(node)) {
			const hit = findRateLimits(value);

			if (hit !== undefined) {
				return hit;
			}
		}

		return undefined;
	}

	for (const candidate of files.slice(0, 8)) {
		let content: string;

		try {
			content = readFile(candidate.filePath);
		} catch {
			continue;
		}

		let latest: unknown;

		for (const line of content.split(/\r?\n/u)) {
			if (!line.includes("rate_limits")) {
				continue;
			}

			try {
				const hit = findRateLimits(JSON.parse(line));

				if (hit !== undefined) {
					latest = hit;
				}
			} catch {
				// Ignore partial JSONL lines.
			}
		}

		if (latest !== undefined) {
			return latest;
		}
	}

	return undefined;
}

/** Reads Codex login status, and when signed in checks the latest session rate-limit snapshot. */
export async function readCodex(config: SourceConfig, deps: SourceDeps): Promise<ServiceReport> {
	const result = await deps.exec(config.codexCmd, ["login", "status"], 10_000);

	if (result.code === null && result.error) {
		return {
			service: "codex",
			status: "error",
			summary: result.error,
			limits: [],
			error: result.error,
		};
	}

	const status = parseCodexLoginStatus(result.code, result.stdout, result.stderr);

	if (!status.signedIn) {
		return {
			service: "codex",
			status: "signed-out",
			summary: "signed out",
			limits: [],
		};
	}

	const latest = findLatestCodexRateLimits(config.codexSessionsDir, deps.readFile);

	return parseCodexRateLimits(latest, deps.now(), config.timeZone);
}

// --- 4. Cloudflare Workers AI daily neurons ---

const CF_NEURONS_QUERY = `query($tag: string!, $today: Date!) {
  viewer {
    accounts(filter: {accountTag: $tag}) {
      aiInferenceAdaptiveGroups(limit: 100, filter: {date: $today}) {
        sum { totalNeurons }
        dimensions { modelId errorCode }
        count
      }
    }
  }
}`;

/** Parses Cloudflare GraphQL `aiInferenceAdaptiveGroups` response into a daily neurons limit. */
export function parseCloudflareNeurons(
	raw: unknown,
	todayUtc: string,
	dailyLimit: number,
): ServiceReport {
	if (!isRecord(raw)) {
		return {
			service: "cloudflare-ai",
			status: "error",
			summary: "invalid graphql response",
			limits: [],
			error: "invalid graphql response",
		};
	}

	const gqlErrors = Array.isArray(raw["errors"]) ? raw["errors"] : [];

	if (gqlErrors.length > 0) {
		const first = isRecord(gqlErrors[0]) ? asString(gqlErrors[0]["message"]) : undefined;
		const msg = first ?? "cloudflare graphql error";

		return {
			service: "cloudflare-ai",
			status: "error",
			summary: msg,
			limits: [],
			error: msg,
		};
	}

	const data = isRecord(raw["data"]) ? raw["data"] : undefined;
	const viewer = data && isRecord(data["viewer"]) ? data["viewer"] : undefined;
	const accounts = viewer && Array.isArray(viewer["accounts"]) ? viewer["accounts"] : [];
	const account = isRecord(accounts[0]) ? accounts[0] : undefined;
	const groups =
		account && Array.isArray(account["aiInferenceAdaptiveGroups"])
			? account["aiInferenceAdaptiveGroups"]
			: undefined;

	if (!groups) {
		return {
			service: "cloudflare-ai",
			status: "error",
			summary: "missing account analytics data",
			limits: [],
			error: "missing account analytics data",
		};
	}

	let totalNeurons = 0;
	let capHits = 0;

	for (const row of groups) {
		if (!isRecord(row)) {
			continue;
		}

		const sum = isRecord(row["sum"]) ? row["sum"] : undefined;
		const dims = isRecord(row["dimensions"]) ? row["dimensions"] : undefined;
		const neurons = asNumber(sum?.["totalNeurons"]) ?? 0;

		totalNeurons += neurons;

		if (asNumber(dims?.["errorCode"]) === 4006) {
			capHits += asNumber(row["count"]) ?? 1;
		}
	}

	const rawPct = (totalNeurons / dailyLimit) * 100;
	const usedPct = Math.round((capHits > 0 ? Math.max(rawPct, 100) : rawPct) * 10) / 10;
	const dayParts = todayUtc.split("-").map(Number);
	const resetAtMs = Date.UTC(dayParts[0] ?? 2026, (dayParts[1] ?? 1) - 1, (dayParts[2] ?? 1) + 1);
	const detail = `${fmtInt(totalNeurons)}/${fmtInt(dailyLimit)} neurons`;
	const capNote = capHits > 0 ? ` · ${String(capHits)} cap hits (4006)` : "";

	return {
		service: "cloudflare-ai",
		status: "ok",
		summary: `${detail} (${fmtPct(rawPct)}%)${capNote} · resets 00:00 UTC`,
		limits: [
			{
				id: "cloudflare-ai:daily",
				label: "Cloudflare Workers AI daily neurons",
				usedPct,
				windowId: todayUtc,
				resetAtMs,
				resetLabel: "00:00 UTC",
				detail,
			},
		],
	};
}

/** Reads Cloudflare Workers AI daily neurons on the lab account. Token is never printed or logged. */
export async function readCloudflareAi(
	config: SourceConfig,
	deps: SourceDeps,
): Promise<ServiceReport> {
	const tokenResult = await deps.exec(config.vaultCmd, ["get", config.cfVaultKey], 15_000);

	if (tokenResult.code !== 0) {
		const msg = tokenResult.error
			? `vault get failed: ${tokenResult.error}`
			: `vault get failed (exit ${String(tokenResult.code)})`;

		return {
			service: "cloudflare-ai",
			status: "error",
			summary: msg,
			limits: [],
			error: msg,
		};
	}

	const token = tokenResult.stdout.trim();

	if (!token) {
		return {
			service: "cloudflare-ai",
			status: "error",
			summary: "empty cloudflare token from vault",
			limits: [],
			error: "empty cloudflare token from vault",
		};
	}

	const todayUtc = utcDateKey(deps.now());
	let response: HttpResponse;

	try {
		response = await deps.http(config.cfGraphqlUrl, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				query: CF_NEURONS_QUERY,
				variables: { tag: config.cfAccountId, today: todayUtc },
			}),
			timeoutMs: 15_000,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : "request failed";

		return {
			service: "cloudflare-ai",
			status: "error",
			summary: `cloudflare api failed: ${msg}`,
			limits: [],
			error: `cloudflare api failed: ${msg}`,
		};
	}

	if (!response.ok) {
		const msg = `cloudflare api HTTP ${String(response.status)}`;

		return {
			service: "cloudflare-ai",
			status: "error",
			summary: msg,
			limits: [],
			error: msg,
		};
	}

	try {
		return parseCloudflareNeurons(JSON.parse(response.text), todayUtc, config.cfDailyNeurons);
	} catch {
		return {
			service: "cloudflare-ai",
			status: "error",
			summary: "invalid json from cloudflare api",
			limits: [],
			error: "invalid json from cloudflare api",
		};
	}
}

// --- 5. GitHub Actions minutes (PetalNet org) ---

function runnerMultiplier(sku: string): number {
	const lower = sku.toLowerCase();

	if (lower.includes("macos")) {
		return 10;
	}

	if (lower.includes("windows")) {
		return 2;
	}

	return 1;
}

/** Parses GitHub org billing usage items into monthly private-repo Actions minutes vs included cap. */
export function parseGitHubActionsUsage(
	raw: unknown,
	publicRepos: ReadonlySet<string>,
	year: number,
	month: number,
	includedMinutes: number,
	org: string,
): ServiceReport {
	if (!isRecord(raw) || !Array.isArray(raw["usageItems"])) {
		return {
			service: "github-actions",
			status: "error",
			summary: "unexpected github billing payload",
			limits: [],
			error: "unexpected github billing payload",
		};
	}

	let privateMinutes = 0;
	let publicMinutes = 0;

	for (const item of raw["usageItems"]) {
		if (!isRecord(item)) {
			continue;
		}

		const product = asString(item["product"])?.toLowerCase();
		const unit = asString(item["unitType"])?.toLowerCase();

		if (product !== "actions" || unit !== "minutes") {
			continue;
		}

		const quantity = asNumber(item["quantity"]) ?? 0;
		const repo = asString(item["repositoryName"]) ?? "";
		const sku = asString(item["sku"]) ?? "";

		if (repo !== "" && publicRepos.has(repo)) {
			publicMinutes += quantity;
		} else {
			privateMinutes += quantity * runnerMultiplier(sku);
		}
	}

	const usedPct = Math.round((privateMinutes / includedMinutes) * 1000) / 10;
	const windowId = `${String(year)}-${String(month).padStart(2, "0")}`;
	const resetAtMs = Date.UTC(year, month, 1);
	const resetLabel = formatDateShort(resetAtMs, "UTC");
	const detail = `${fmtInt(privateMinutes)}/${fmtInt(includedMinutes)} private min`;

	return {
		service: "github-actions",
		status: "ok",
		summary: `${detail} (${fmtPct(usedPct)}%) · public ${fmtInt(publicMinutes)} min · resets ${resetLabel}`,
		limits: [
			{
				id: "github-actions:private-minutes",
				label: `GitHub Actions (${org} private)`,
				usedPct,
				windowId,
				resetAtMs,
				resetLabel: `${resetLabel} UTC`,
				detail,
			},
		],
	};
}

/** Reads GitHub Actions minutes for the configured org from the GitHub billing API. */
export async function readGitHubActions(
	config: SourceConfig,
	deps: SourceDeps,
): Promise<ServiceReport> {
	let token: string;

	try {
		token = deps.readFile(config.githubTokenFile).trim();
	} catch {
		return {
			service: "github-actions",
			status: "error",
			summary: `cannot read ${config.githubTokenFile}`,
			limits: [],
			error: `cannot read ${config.githubTokenFile}`,
		};
	}

	if (!token) {
		return {
			service: "github-actions",
			status: "error",
			summary: "empty github token",
			limits: [],
			error: "empty github token",
		};
	}

	const now = new Date(deps.now());
	const year = now.getUTCFullYear();
	const month = now.getUTCMonth() + 1;
	const headers = {
		Authorization: `Bearer ${token}`,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	const base = config.githubApiUrl.replace(/\/+$/u, "");
	const org = encodeURIComponent(config.githubOrg);

	async function fetchPublicRepos(page = 1, names = new Set<string>()): Promise<Set<string>> {
		const res = await deps.http(
			`${base}/orgs/${org}/repos?type=public&per_page=100&page=${String(page)}`,
			{ headers, timeoutMs: 15_000 },
		);

		if (!res.ok) {
			throw new Error(`github repos HTTP ${String(res.status)}`);
		}

		const list: unknown = JSON.parse(res.text);

		if (!Array.isArray(list)) {
			return names;
		}

		for (const repo of list) {
			const name = isRecord(repo) ? asString(repo["name"]) : undefined;

			if (name) {
				names.add(name);
			}
		}

		if (list.length < 100 || page >= 10) {
			return names;
		}

		return fetchPublicRepos(page + 1, names);
	}

	async function resolveIncludedMinutes(): Promise<number> {
		if (config.githubActionsLimit !== undefined) {
			return config.githubActionsLimit;
		}

		const res = await deps.http(`${base}/orgs/${org}`, { headers, timeoutMs: 15_000 });

		if (!res.ok) {
			return 2_000;
		}

		const parsed: unknown = JSON.parse(res.text);
		const plan =
			isRecord(parsed) && isRecord(parsed["plan"]) ? asString(parsed["plan"]["name"]) : undefined;

		return (plan ? PLAN_INCLUDED_MINUTES[plan.toLowerCase()] : undefined) ?? 2_000;
	}

	try {
		const [usageRes, publicRepos, includedMinutes] = await Promise.all([
			deps.http(
				`${base}/orgs/${org}/settings/billing/usage?year=${String(year)}&month=${String(month)}`,
				{ headers, timeoutMs: 15_000 },
			),
			fetchPublicRepos(),
			resolveIncludedMinutes(),
		]);

		if (!usageRes.ok) {
			const msg = `github billing HTTP ${String(usageRes.status)}`;

			return {
				service: "github-actions",
				status: "error",
				summary: msg,
				limits: [],
				error: msg,
			};
		}

		return parseGitHubActionsUsage(
			JSON.parse(usageRes.text),
			publicRepos,
			year,
			month,
			includedMinutes,
			config.githubOrg,
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : "github api failed";

		return {
			service: "github-actions",
			status: "error",
			summary: msg,
			limits: [],
			error: msg,
		};
	}
}

// --- 6. T-Mobile data budget (dot14 ~/.claude/state/data-budget.json) ---

/** Parses the data-budget-meter JSON snapshot into cycle and priority-week limits. */
export function parseTMobileBudget(raw: unknown, nowMs: number, timeZone: string): ServiceReport {
	if (!isRecord(raw) || !isRecord(raw["last"])) {
		return {
			service: "tmobile",
			status: "error",
			summary: "invalid data-budget payload",
			limits: [],
			error: "invalid data-budget payload",
		};
	}

	const last = raw["last"];
	const totalGb = asNumber(last["total_gb"]);
	const budgetGb = asNumber(last["budget_gb"]);

	if (totalGb === undefined || budgetGb === undefined || budgetGb <= 0) {
		return {
			service: "tmobile",
			status: "error",
			summary: "missing total_gb or budget_gb",
			limits: [],
			error: "missing total_gb or budget_gb",
		};
	}

	const cyclePct = Math.round((asNumber(last["pct"]) ?? (totalGb / budgetGb) * 100) * 10) / 10;
	const cycleKey =
		asString(raw["cycle"]) ?? asString(last["cycle_start"])?.slice(0, 10) ?? utcDateKey(nowMs);
	const cycleEndMs = parseIsoMs(asString(last["cycle_end"]));
	const cycleEndLabel =
		cycleEndMs === undefined ? undefined : formatDateShort(cycleEndMs, timeZone);
	const cycleDetail = `${totalGb.toFixed(1)}/${fmtInt(budgetGb)} GB`;

	const limits: QuotaLimit[] = [
		{
			id: "tmobile:cycle",
			label: "T-Mobile cycle data",
			usedPct: cyclePct,
			windowId: `cycle:${cycleKey}`,
			resetAtMs: cycleEndMs,
			resetLabel: cycleEndLabel,
			detail: cycleDetail,
		},
	];

	const parts: string[] = [
		cycleEndLabel
			? `${cycleDetail} (${fmtPct(cyclePct)}%, resets ${cycleEndLabel})`
			: `${cycleDetail} (${fmtPct(cyclePct)}%)`,
	];

	const priorityGb = asNumber(last["priority_week_gb"]);
	const priorityBudget = asNumber(last["priority_week_budget_gb"]);
	const priorityPctRaw = asNumber(last["priority_week_pct"]);
	const weekStart = asString(last["week_start"]);

	if (priorityGb !== undefined && priorityBudget !== undefined && priorityBudget > 0) {
		const priorityPct =
			Math.round((priorityPctRaw ?? (priorityGb / priorityBudget) * 100) * 10) / 10;
		const weekStartMs = parseIsoMs(weekStart);
		const weekEndMs = weekStartMs === undefined ? undefined : weekStartMs + 7 * 86_400_000;
		const weekKey = weekStart ? weekStart.slice(0, 10) : utcDateKey(nowMs);
		const priorityDetail = `${priorityGb.toFixed(1)}/${fmtInt(priorityBudget)} GB`;

		limits.push({
			id: "tmobile:priority-week",
			label: "T-Mobile priority week",
			usedPct: priorityPct,
			windowId: `week:${weekKey}`,
			resetAtMs: weekEndMs,
			resetLabel: weekEndMs === undefined ? undefined : formatDateShort(weekEndMs, timeZone),
			detail: priorityDetail,
		});

		parts.push(`priority wk ${priorityDetail} (${fmtPct(priorityPct)}%)`);
	}

	const sampleMs = parseIsoMs(asString(last["t"]));

	if (sampleMs !== undefined && nowMs - sampleMs > TMOBILE_STALE_MS) {
		parts.push(`stale ${String(Math.floor((nowMs - sampleMs) / 60_000))}m`);
	}

	return {
		service: "tmobile",
		status: "ok",
		summary: parts.join(" · "),
		limits,
	};
}

/** Reads T-Mobile data budget from a local file override or `dot14` over SSH. */
export async function readTMobile(config: SourceConfig, deps: SourceDeps): Promise<ServiceReport> {
	let rawText: string;

	if (config.tmobileFile) {
		try {
			rawText = deps.readFile(config.tmobileFile);
		} catch {
			return {
				service: "tmobile",
				status: "error",
				summary: `cannot read ${config.tmobileFile}`,
				limits: [],
				error: `cannot read ${config.tmobileFile}`,
			};
		}
	} else {
		const result = await deps.exec(
			"ssh",
			[
				"-o",
				"BatchMode=yes",
				"-o",
				"ConnectTimeout=5",
				"--",
				config.tmobileSshHost,
				"cat",
				config.tmobileRemotePath,
			],
			15_000,
		);

		if (result.code !== 0) {
			const errText = result.stderr.trim();
			const msg = errText === "" ? (result.error ?? `ssh exit ${String(result.code)}`) : errText;

			return {
				service: "tmobile",
				status: "error",
				summary: msg,
				limits: [],
				error: msg,
			};
		}

		rawText = result.stdout;
	}

	try {
		return parseTMobileBudget(JSON.parse(rawText), deps.now(), config.timeZone);
	} catch {
		return {
			service: "tmobile",
			status: "error",
			summary: "invalid json from data-budget meter",
			limits: [],
			error: "invalid json from data-budget meter",
		};
	}
}

/** Reads all six lab quota services concurrently. */
export async function readAllServices(
	config: SourceConfig,
	deps: SourceDeps,
): Promise<ServiceReport[]> {
	return Promise.all([
		readClaude(config, deps),
		readGoogleAi(config, deps),
		readCodex(config, deps),
		readCloudflareAi(config, deps),
		readGitHubActions(config, deps),
		readTMobile(config, deps),
	]);
}
