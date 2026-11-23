import { readFile, readdir, rename, statfs, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
	defaultSourceDeps,
	readClaude,
	readGoogleAi,
	sourceConfigFromEnv,
	type QuotaLimit,
	type ServiceReport,
} from "@petalnet/harness-hooks/quota-sources";

import { classRefusal, POOLS, resolveTarget, vendorOf, type DataClass } from "./policy.ts";
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
import { routeCommand } from "./route-args.ts";
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

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

async function liveRouterProcesses(): Promise<Map<number, string[]>> {
	const directories = await readdir("/proc");
	const processes = await Promise.all(
		directories
			.filter((entry) => /^\d+$/u.test(entry))
			.map(async (pid) => {
				const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
				const args = cmdline.split("\0").filter(Boolean);

				const entry = args.findIndex((arg) => arg.endsWith("/route.ts"));

				const routeArgs = args.slice(entry + 1);
				const command = entry > 0 ? routeCommand(routeArgs) : undefined;

				return command?.value === "run"
					? [[Number(pid), routeArgs.slice(command.index + 1)] as const]
					: [];
			}),
	);

	return new Map(processes.flat());
}

async function jsonLines(file: string): Promise<unknown[]> {
	const body = await readFile(file, "utf8").catch((error: unknown) => {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
			throw error;
		}

		return "";
	});

	return body.split("\n").map(parseJson);
}

export function readLedger(
	rows: unknown[],
	now: number,
	processes: ReadonlyMap<number, string[]>,
): { runs: Run[]; active: Run[] } {
	const runs: Run[] = [];
	const active = new Map<string, Run>();

	for (const value of rows) {
		const { pool, model, effort, startedAt, endedAt, event, runId, attempt, routePid, briefName } =
			record(value);

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

		if (event === "launch" && startedAt <= now) {
			const live =
				typeof routePid === "number"
					? processes.has(routePid)
					: Array.from(processes.values()).some(
							([offer, ...args]) =>
								typeof briefName === "string" &&
								briefName !== "" &&
								(offer === model ||
									offer === `${model}-${effort}` ||
									offer?.startsWith(`${model}:`) === true) &&
								(args.includes("-") ||
									args.some(
										(arg) =>
											path.basename(arg, ".md") === briefName || arg.trim().startsWith(briefName),
									)),
						);

			if (live || now - startedAt < 60_000) {
				active.set(key, { ...run, end: now + HOUR_MS, running: true });
			}
		}

		if (event === "outcome") {
			active.delete(key);

			if (typeof endedAt === "number" && endedAt > startedAt && endedAt >= now - KEEP_MS) {
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

async function readPacingCodex(): Promise<ServiceReport> {
	const script = fileURLToPath(
		new URL("../../../apps/astrolabe/feed/codex-usage.ts", import.meta.url),
	);
	const answer = await defaultSourceDeps().exec(
		process.execPath,
		[script, "--json", "--live-only"],
		25_000,
	);
	const raw = answer.code === 0 ? parseJson(answer.stdout) : undefined;
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
				resetAtMs: typeof reset === "number" && reset > 0 ? reset * 1_000 : undefined,
				idle: usedPct === 0 && (reset === null || reset === 0) ? true : undefined,
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
	builders: Builder[],
	reports: Record<string, ServiceReport>,
	now: number,
	dataClass: DataClass,
): Candidate[] {
	return builders.flatMap(({ pool: poolId, model, effort }) => {
		const target = resolveTarget(`${model}:${effort}`);
		const pool = target?.pool;
		const report = pool?.service && reports[pool.service];

		if (
			!target ||
			pool?.id !== poolId ||
			!providerCaps.has(pool.plan) ||
			classRefusal(target, dataClass, false) ||
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

			const duration = windowDuration(id);

			if (limit?.idle || report.idleLimits?.includes(id)) {
				return [{ id, usedPct: 0, resetAt: now + duration, duration, idle: true as const }];
			}

			return limit?.resetAtMs
				? [{ id, usedPct: limit.usedPct, resetAt: limit.resetAtMs, duration }]
				: [];
		});

		return windows.length === required.length
			? [{ pool: pool.id, provider: pool.plan, model, effort, windows }]
			: [];
	});
}

async function pace(
	dir: string,
	reports: Record<string, ServiceReport>,
	dataClass: DataClass,
	request?: { excludedVendor: string | undefined },
) {
	const now = Date.now();
	const current = Object.values(reports).flatMap((report) => {
		const at = report.observedAtMs;

		const scope = report.service === "codex" ? report.summary : report.service;

		return report.status === "ok" && at !== undefined && at <= now && now - at <= FRESH_MS
			? [
					{
						at,
						scope,
						limits: report.limits.filter(
							(limit) => !limit.idle && limit.resetAtMs && limit.resetAtMs > now,
						),
					},
				]
			: [];
	});
	const file = path.join(dir, "pacing-readings.jsonl");
	const [history, ledger, memory, disk, processes] = await Promise.all([
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
		request ? undefined : readFile("/proc/meminfo", "utf8"),
		request ? undefined : statfs("/"),
		liveRouterProcesses(),
	]);
	const { active, runs } = readLedger(ledger, now, processes);
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

	// Host slots govern the scheduler's extra work. A requested run needs one quota decision.
	const slots = request
		? 1
		: !memory || !disk || processes.size > active.length
			? 0
			: hostSlots(
					Number(/^MemAvailable:\s+(\d+)/mu.exec(memory)?.[1] ?? 0) / 1024,
					(disk.bsize * disk.bavail) / 1024 ** 2,
					Math.max(active.length, processes.size),
				);
	const builders = new Map<string, Builder>();

	for (const { pool, model, effort } of [
		...BOOTSTRAP_BURN.map(({ builder }) => builder),
		...runs,
	]) {
		builders.set(JSON.stringify([pool, model, effort]), { pool, model, effort });
	}

	const candidates = buildCandidates([...builders.values()], reports, now, dataClass).filter(
		({ model }) => vendorOf(model) !== request?.excludedVendor,
	);
	const input = {
		now,
		slots,
		candidates,
		active,
		burns,
		providerCaps,
		poolProviders,
		windowsByPool,
	};
	const preferred = request
		? recommend({
				...input,
				candidates: candidates.filter(
					({ pool, model, effort }) =>
						pool === "codex" && model === "gpt-6.2-sol" && effort === "high",
				),
			})[0]
		: undefined;

	return {
		selected: preferred ? [preferred] : recommend(input),
		slots,
		active: active.length,
		burns: burns.size,
	};
}

export async function defaultTarget(dir: string, dataClass: DataClass, notVendor?: string) {
	const excludedVendor = notVendor?.toLowerCase();

	if (dataClass === "parcs") {
		return excludedVendor === vendorOf("opus") ? undefined : resolveTarget("opus:high");
	}

	const [codex, google] = await Promise.all([
		readPacingCodex(),
		dataClass === "public" ? readGoogleAi(sourceConfigFromEnv(), defaultSourceDeps()) : undefined,
	]);
	const { selected } = await pace(
		dir,
		google ? { codex, "google-ai": google } : { codex },
		dataClass,
		{
			excludedVendor,
		},
	);
	const first = selected[0];

	return first ? resolveTarget(`${first.model}:${first.effort}`) : undefined;
}

function formatPace(
	reports: Record<string, ServiceReport>,
	{ selected, slots, active, burns }: Awaited<ReturnType<typeof pace>>,
): string {
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
		const windows =
			report?.limits.map(
				({ id, usedPct, resetAtMs, idle }) =>
					`${id} ${String(usedPct)}% used, reset ${idle ? "starts with use" : resetAtMs ? new Date(resetAtMs).toISOString() : "unknown"}`,
			) ?? [];

		windows.push(
			...(report?.idleLimits ?? []).map((id) => `${id} 0% used, reset starts with use`),
			...(report?.inactiveLimits ?? []).map((id) => `${id} inactive`),
		);

		return `${plan}${report?.status === "ok" ? "" : " (unavailable)"} ${windows.length > 0 ? windows.join(" / ") : "no limits reported"}`;
	});

	return [
		...(decisions.length > 0
			? decisions
			: [
					`hold (host slots ${String(slots)}, active ${String(active)}, calibrated rates ${String(burns)})`,
				]),
		...status,
	].join("\n");
}

export async function quotaMain(args: string[]): Promise<number> {
	let dataClass: DataClass;

	try {
		const { values, positionals } = parseArgs({
			args,
			allowPositionals: true,
			options: {
				class: { type: "string" },
				for: { type: "string" },
			},
		});
		const value = values.class ?? "public";

		if (
			positionals.length > 0 ||
			(value !== "public" && value !== "sensitive" && value !== "parcs")
		) {
			throw new Error("invalid quota options");
		}

		dataClass = value;
	} catch {
		process.stderr.write("usage: quota [--class <public|sensitive|parcs>]\n");

		return 2;
	}

	const config = sourceConfigFromEnv();
	const deps = defaultSourceDeps();
	const [codex, google, claude] = await Promise.all([
		readPacingCodex(),
		readGoogleAi(config, deps),
		readClaude(config, deps),
	]);
	const directory = path.join(homedir(), ".local/state/router");

	const reports = { codex, "google-ai": google, claude };

	process.stdout.write(`${formatPace(reports, await pace(directory, reports, dataClass))}\n`);

	return 0;
}
