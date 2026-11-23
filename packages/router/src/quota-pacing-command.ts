import { readFile, rename, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	defaultSourceDeps,
	type QuotaLimit,
	type ServiceReport,
} from "@petalnet/harness-hooks/quota-sources";

import { POOLS, type Pick } from "./pick.ts";
import { BOOTSTRAP_BURN } from "./quota-pacing-history.ts";
import {
	burnKey,
	CHECK_INTERVAL_MS,
	HOUR_MS,
	estimateBurn,
	hostSlots,
	recommend,
	type Builder,
	type Candidate,
	type Reading,
	type Run,
} from "./quota-pacing.ts";
import { locked } from "./state.ts";

const KEEP_MS = 14 * 24 * HOUR_MS;
const FRESH_MS = CHECK_INTERVAL_MS;
const REPORT_PLANS = ["codex", "google-ai", "claude"];

// Observed successful overlap is higher. Leave capacity for work that starts outside this job.
const providerCaps = new Map([
	["codex", 6],
	["google-ai", 2],
]);
const windowsByPool = new Map(POOLS.map((pool) => [pool.id, pool.windows]));
const poolProviders = new Map(POOLS.map((pool) => [pool.id, pool.plan]));
const windowDuration = (id: string) => (id.endsWith(":5h") ? 5 : 168) * HOUR_MS;

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: {};
}

async function jsonLines(file: string): Promise<unknown[]> {
	const body = await readFile(file, "utf8").catch((error: unknown) => {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
			throw error;
		}

		return "";
	});

	return body.split("\n").flatMap((line) => {
		try {
			const row: unknown = JSON.parse(line);

			return [row];
		} catch {
			// A historical corrupt row or a partial last line is never a quota observation.
			return [];
		}
	});
}

function readLedger(rows: unknown[], now: number): { runs: Run[]; active: Run[] } {
	const runs: Run[] = [];
	const active = new Map<string, Run>();

	for (const value of rows) {
		const { pool, model, effort, startedAt, endedAt, event, runId, attempt } = record(value);

		if (
			typeof pool !== "string" ||
			typeof model !== "string" ||
			typeof effort !== "string" ||
			typeof startedAt !== "number" ||
			typeof runId !== "string" ||
			typeof attempt !== "number"
		) {
			continue;
		}

		const key = JSON.stringify([runId, attempt, startedAt]);
		const run = { pool, model, effort, start: startedAt };

		if (event === "launch" && startedAt <= now && now - startedAt < 6 * HOUR_MS) {
			active.set(key, { ...run, end: now + HOUR_MS, running: true });
		}

		if (event === "outcome" && typeof endedAt === "number" && endedAt > startedAt) {
			active.delete(key);

			if (endedAt >= now - KEEP_MS) {
				runs.push({ ...run, end: endedAt });
			}
		}
	}

	return { runs, active: Array.from(active.values()) };
}

function decodeReading(value: unknown): Reading[] {
	const { at, limits, scope } = record(value);

	if (typeof at !== "number" || !Array.isArray(limits)) {
		return [];
	}

	const windows = limits.flatMap((limit: unknown) => {
		const { id, usedPct, resetAtMs } = record(limit);

		return typeof id === "string" &&
			typeof usedPct === "number" &&
			usedPct >= 0 &&
			typeof resetAtMs === "number"
			? [{ id, label: id, usedPct, resetAtMs }]
			: [];
	});

	return [{ at, limits: windows, ...(typeof scope === "string" ? { scope } : {}) }];
}

export async function readPacingCodex(): Promise<ServiceReport> {
	const script = fileURLToPath(
		new URL("../../../apps/astrolabe/feed/codex-usage.ts", import.meta.url),
	);
	const answer = await defaultSourceDeps().exec(
		process.execPath,
		[script, "--json", "--live-only"],
		25_000,
	);
	const raw: unknown = answer.code === 0 ? JSON.parse(answer.stdout) : {};
	const reading = record(raw);
	const {
		scraped_at: scrapedAt,
		snapshot_age_sec: age,
		plan,
		awaiting,
		rate_limit_reached_type: blocked,
	} = reading;
	const observedAtMs =
		typeof scrapedAt === "number" && typeof age === "number"
			? (scrapedAt - age) * 1_000
			: undefined;
	const limits: QuotaLimit[] = [];

	for (const [field, window] of [
		["five_hour", "5h"],
		["seven_day", "7d"],
	] as const) {
		const usedPct = reading[`${field}_pct`];
		const reset = reading[`${field}_resets_at`];

		if (typeof usedPct === "number") {
			limits.push({
				id: `codex:${window}`,
				label: `Codex ${window}`,
				usedPct,
				resetAtMs: typeof reset === "number" ? reset * 1_000 : undefined,
			});
		}
	}

	return {
		service: "codex",
		status: awaiting === false && !blocked ? "ok" : "error",
		summary: typeof plan === "string" ? plan : "plan unavailable",
		limits,
		observedAtMs,
		inactiveLimits:
			plan === "prolite" &&
			reading["five_hour_pct"] === null &&
			typeof reading["seven_day_pct"] === "number"
				? ["codex:5h"]
				: [],
	};
}

function buildCandidates(
	result: Pick,
	reports: Record<string, ServiceReport>,
	now: number,
): Candidate[] {
	return result.ranked.flatMap(({ offer }) => {
		const pool = offer.pool;
		const report = pool?.service && reports[pool.service];

		if (
			!pool ||
			report?.status !== "ok" ||
			report.observedAtMs === undefined ||
			report.observedAtMs > now ||
			now - report.observedAtMs > FRESH_MS
		) {
			return [];
		}

		const required = pool.windows.filter((id) => !report.inactiveLimits?.includes(id));
		const windows = required.flatMap((id) => {
			const limit = report.limits.find((entry) => entry.id === id);

			return limit?.resetAtMs
				? [{ id, usedPct: limit.usedPct, resetAt: limit.resetAtMs, duration: windowDuration(id) }]
				: [];
		});

		return windows.length === required.length
			? [{ pool: pool.id, provider: pool.plan, model: offer.model, effort: offer.effort, windows }]
			: [];
	});
}

export async function pace(
	dir: string,
	result: Pick,
	reports: Record<string, ServiceReport>,
): Promise<string> {
	const now = Date.now();
	const current = Object.values(reports).flatMap((report) => {
		const at = report.observedAtMs;

		const scope = report.service === "codex" ? report.summary : report.service;

		return report.status === "ok" && at !== undefined && at <= now && now - at <= FRESH_MS
			? [
					{
						at,
						scope,
						limits: report.limits.filter((limit) => limit.resetAtMs && limit.resetAtMs > now),
					},
				]
			: [];
	});
	const file = path.join(dir, "pacing-readings.jsonl");
	const candidates = buildCandidates(result, reports, now);
	const [history, ledger, memory, disk] = await Promise.all([
		locked(dir, async () => {
			const previous = (await jsonLines(file)).flatMap(decodeReading);
			const readings = previous.filter((r) => r.at >= now - KEEP_MS);
			const next = current.filter(
				(r) =>
					r.limits.length > 0 && !readings.some((old) => old.at === r.at && old.scope === r.scope),
			);
			const updated = [...readings, ...next];

			if (next.length > 0 || previous.length !== readings.length) {
				const temporary = `${file}.tmp`;

				await writeFile(temporary, `${updated.map((r) => JSON.stringify(r)).join("\n")}\n`, {
					mode: 0o600,
				});

				await rename(temporary, file);
			}

			return updated;
		}),
		jsonLines(path.join(dir, "ledger.jsonl")),
		readFile("/proc/meminfo", "utf8"),
		statfs("/"),
	]);
	const { active, runs } = readLedger(ledger, now);
	const scopes = new Set(current.map((reading) => reading.scope));
	const burns = estimateBurn(
		history.filter((reading) => reading.scope && scopes.has(reading.scope)),
		[...runs, ...active],
		windowsByPool,
	);

	for (const {
		scope,
		window,
		builder,
		until,
		perHour,
		perRun,
		hoursPerRun,
		samples,
	} of BOOTSTRAP_BURN) {
		const key = burnKey(builder, window);

		if (now < until && scopes.has(scope) && !burns.has(key)) {
			burns.set(key, { perHour: perHour * 1.5, perRun: perRun * 1.5, hoursPerRun, samples });
		}
	}

	const slots = hostSlots(
		Number(/^MemAvailable:\s+(\d+)/mu.exec(memory)?.[1] ?? 0) / 1024,
		(disk.bsize * disk.bavail) / 1024 ** 2,
	);
	const selected = recommend({
		now,
		slots,
		candidates,
		active,
		burns,
		providerCaps,
		poolProviders,
		windowsByPool,
	});
	const counts = new Map<string, { builder: Builder; count: number }>();

	for (const builder of selected) {
		const key = JSON.stringify([builder.pool, builder.model, builder.effort]);

		counts.set(key, { builder, count: (counts.get(key)?.count ?? 0) + 1 });
	}

	const decisions = Array.from(
		counts.values(),
		({ builder, count }) =>
			`launch ${builder.pool} ${builder.model}:${builder.effort} +${String(count)}`,
	);
	const status = REPORT_PLANS.map((plan) => {
		const report = reports[plan];
		const windows = report?.limits.map(
			({ id, usedPct, resetAtMs }) =>
				`${id} ${String(usedPct)}% used, reset ${resetAtMs ? new Date(resetAtMs).toISOString() : "unknown"}`,
		);

		return `${plan} ${windows?.length ? windows.join(" / ") : "quota unavailable"}`;
	});

	return [
		...(decisions.length > 0
			? decisions
			: [
					`hold (host slots ${String(slots)}, active ${String(active.length)}, calibrated rates ${String(burns.size)})`,
				]),
		...status,
	].join("\n");
}
