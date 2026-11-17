import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import * as SunCalc from "suncalc";

import { DEFAULT_PLANS, type Provider, type WindowSpan } from "../plans.js";
import type { ServiceCounts } from "../services.js";
import { nextSolarEvent, type SolarEvent } from "../sky.js";

const execFileAsync = promisify(execFile);
const FIFTEEN_MINUTES_SECONDS = 15 * 60;
const BACKUP_STALE_AFTER_MS = 26 * 60 * 60 * 1000;
const SYNODIC_MONTH_DAYS = 29.53058867;

/** A limit window as the provider reports it. */
export interface ReportedWindow {
	span: WindowSpan;
	/** The model a per-model weekly limit covers, such as "Fable". Null for the overall limit. */
	model: string | null;
	/** Percent of the limit used (Claude's `utilization`/`percent`, Codex's `used_percent`), not left. */
	usedPct: number | null;
	/** Epoch seconds. */
	resetsAt: number | null;
	/** Claude's `is_active: false` on a per-model limit. */
	inactive: boolean;
}

export interface UsageReadout {
	slug: "janet-primary" | "codex";
	label: "Claude" | "Codex";
	kind: Provider;
	/** The configured plan, from `CLAUDE_PLAN`/`CODEX_PLAN` or `DEFAULT_PLANS`. */
	plan: string;
	/** The plan the provider says the account is on. Only Codex reports one. */
	reportedPlan: string | null;
	/** Every window the feed reports. Empty with `read` false when there is no feed to read. */
	windows: ReportedWindow[];
	/** Limit kinds in Claude's `limits` list that Astrolabe has no reading for. */
	unreadKinds: string[];
	read: boolean;
	creditsBalance: number | null;
	/** Codex's `rate_limit_reached_type`: set only when a limit has actually stopped requests. */
	limitReachedType: string | null;
	scrapedAt: number | null;
	/**
	 * Epoch seconds the usage figures were true at. Codex reads a session snapshot older than the
	 * scrape.
	 */
	observedAt: number | null;
	stale: boolean;
	awaiting: boolean;
}

export interface Dossier {
	now: number;
	sun: {
		sunriseAt: number | null;
		sunsetAt: number | null;
		nextDaySunriseAt: number | null;
		nextEvent: SolarEvent;
		dawnAt: number | null;
		duskAt: number | null;
		solarNoonAt: number | null;
		altitudeDeg: number;
		azimuthDeg: number;
		dayFraction: number;
		phase: SolarPhase;
	};
	moon: { phase: number; illumination: number; ageDays: number; phaseName: MoonPhaseName };
	agents: [UsageReadout, UsageReadout];
	backup: {
		lastSuccessAt: number | null;
		lastAttemptAt: number | null;
		nextScheduledAt: number | null;
		stale: boolean;
	};
	services: ServiceCounts & {
		totalActive: number;
		/** Uptime Kuma's base URL, from KUMA_URL. Without it the plate names monitors unlinked. */
		kumaUrl: string | null;
	};
	host: {
		diskWorst: { mount: string; level: string } | null;
		load: string;
		swap: string;
		containerFails: string[];
		stale: boolean;
	};
	mood: { mood: string; quote: string };
	debug: { errors: string[] };
}

export type MoonPhaseName =
	| "New moon"
	| "Waxing crescent"
	| "First quarter"
	| "Waxing gibbous"
	| "Full moon"
	| "Waning gibbous"
	| "Last quarter"
	| "Waning crescent";
export type SolarPhase = "night" | "dawn" | "morning" | "midday" | "afternoon" | "dusk";

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const numberOrNull = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) ? value : null;
const stringOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

const epochSecondsFromIso = (value: unknown): number | null => {
	if (typeof value !== "string") {
		return null;
	}

	const timestamp = Date.parse(value);

	return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null;
};

const parseJsonFile = async (path: string): Promise<JsonRecord> => {
	const contents = await readFile(path, "utf8");
	const parsed: unknown = JSON.parse(contents);

	if (!isRecord(parsed)) {
		throw new Error("expected a JSON object");
	}

	return parsed;
};

/** @internal Exported for its tests; buildDossier is the module's interface. */
export const moonPhaseName = (phase: number): MoonPhaseName => {
	const normalized = ((phase % 1) + 1) % 1;

	if (normalized < 0.03 || normalized >= 0.97) {
		return "New moon";
	}

	if (normalized < 0.22) {
		return "Waxing crescent";
	}

	if (normalized < 0.28) {
		return "First quarter";
	}

	if (normalized < 0.47) {
		return "Waxing gibbous";
	}

	if (normalized < 0.53) {
		return "Full moon";
	}

	if (normalized < 0.72) {
		return "Waning gibbous";
	}

	if (normalized < 0.78) {
		return "Last quarter";
	}

	return "Waning crescent";
};

/** @internal Exported for its tests; buildDossier is the module's interface. */
export const moonAgeDays = (phase: number): number => (((phase % 1) + 1) % 1) * SYNODIC_MONTH_DAYS;

const timeOf = (date: Date | null): number | null =>
	date !== null && Number.isFinite(date.getTime()) ? date.getTime() : null;

/** @internal Exported for its tests; buildDossier is the module's interface. */
export const solarPhaseName = (
	times: {
		dawnAt: number | null;
		sunriseAt: number | null;
		solarNoonAt: number | null;
		sunsetAt: number | null;
		duskAt: number | null;
	},
	now: number,
): SolarPhase => {
	const { dawnAt, sunriseAt, solarNoonAt, sunsetAt, duskAt } = times;

	if (
		dawnAt === null ||
		sunriseAt === null ||
		solarNoonAt === null ||
		sunsetAt === null ||
		duskAt === null
	) {
		return "night";
	}

	if (now < dawnAt || now >= duskAt) {
		return "night";
	}

	if (now < sunriseAt) {
		return "dawn";
	}

	if (now < solarNoonAt - 60 * 60 * 1000) {
		return "morning";
	}

	if (now < solarNoonAt + 60 * 60 * 1000) {
		return "midday";
	}

	if (now < sunsetAt) {
		return "afternoon";
	}

	return "dusk";
};

const pct = (value: unknown): number | null => {
	const parsed = numberOrNull(value);

	return parsed === null ? null : Math.max(0, Math.min(100, parsed));
};

/**
 * Claude's windows from the raw usage response the snapshot keeps. The top-level `five_hour_pct` is
 * 0 when the response has no 5-hour window at all, so only `raw` tells the two apart.
 */
const claudeWindows = (raw: JsonRecord): { windows: ReportedWindow[]; unreadKinds: string[] } => {
	const windows: ReportedWindow[] = [];
	const unreadKinds: string[] = [];
	const overall = (value: unknown, span: WindowSpan) => {
		if (isRecord(value)) {
			windows.push({
				span,
				model: null,
				usedPct: pct(value.utilization),
				resetsAt: epochSecondsFromIso(value.resets_at),
				inactive: false,
			});
		}
	};

	overall(raw.five_hour, "5-hour");
	overall(raw.seven_day, "7-day");

	for (const limit of Array.isArray(raw.limits) ? raw.limits : []) {
		if (!isRecord(limit)) {
			continue;
		}

		const kind = stringOrNull(limit.kind) ?? "unnamed";
		const scope = isRecord(limit.scope) ? limit.scope : null;
		const model = isRecord(scope?.model) ? stringOrNull(scope.model.display_name) : null;

		if (kind === "weekly_all") {
			// The same window as `seven_day`.
			continue;
		}

		if (kind === "weekly_scoped" && model !== null) {
			windows.push({
				span: "7-day",
				model,
				usedPct: pct(limit.percent),
				resetsAt: epochSecondsFromIso(limit.resets_at),
				inactive: limit.is_active === false,
			});

			continue;
		}

		unreadKinds.push(model === null ? kind : `${kind} (${model})`);
	}

	return { windows, unreadKinds };
};

/** Codex's windows, which codex-usage has already bucketed by length. */
const codexWindows = (data: JsonRecord): ReportedWindow[] =>
	(
		[
			["5-hour", data.five_hour_pct, data.five_hour_resets_at],
			["7-day", data.seven_day_pct, data.seven_day_resets_at],
		] as const
	).flatMap(([span, used, resets]) =>
		used === null && resets === null
			? []
			: [
					{
						span,
						model: null,
						usedPct: pct(used),
						resetsAt: numberOrNull(resets),
						inactive: false,
					},
				],
	);

/** @internal Exported for its tests; buildDossier is the module's interface. */
export const usageReadoutFrom = (input: {
	slug: UsageReadout["slug"];
	label: UsageReadout["label"];
	kind: UsageReadout["kind"];
	plan: string;
	data: JsonRecord | null;
	nowSeconds: number;
}): UsageReadout => {
	const { slug, label, kind, plan, data, nowSeconds } = input;
	const awaiting = kind === "codex" && (data === null || data.awaiting === true);
	const scrapedAt = data === null ? null : numberOrNull(data.scraped_at);
	const raw = kind === "claude" && isRecord(data?.raw) ? data.raw : null;
	const claude = raw === null ? null : claudeWindows(raw);
	const windows =
		data === null || awaiting
			? []
			: kind === "codex"
				? codexWindows(data)
				: (claude?.windows ?? []);

	return {
		slug,
		label,
		kind,
		plan,
		reportedPlan: kind === "codex" && data !== null ? stringOrNull(data.plan) : null,
		windows,
		unreadKinds: claude?.unreadKinds ?? [],
		// A Claude snapshot without `raw` cannot say which windows exist.
		read: !awaiting && data !== null && (kind === "codex" || raw !== null),
		creditsBalance: kind === "codex" && data !== null ? numberOrNull(data.credits_balance) : null,
		limitReachedType:
			kind === "codex" && typeof data?.rate_limit_reached_type === "string"
				? data.rate_limit_reached_type
				: null,
		scrapedAt,
		observedAt: scrapedAt === null ? null : scrapedAt - (numberOrNull(data?.snapshot_age_sec) ?? 0),
		stale: !awaiting && (scrapedAt === null || nowSeconds - scrapedAt > FIFTEEN_MINUTES_SECONDS),
		awaiting,
	};
};

/** @internal Exported for its tests; buildDossier is the module's interface. */
export const parseBackupLog = (
	contents: string,
): { lastSuccessAt: number | null; lastAttemptAt: number | null } => {
	let lastSuccessAt: number | null = null;
	let lastAttemptAt: number | null = null;

	for (const line of contents.split("\n").toReversed()) {
		const match = /^\[([^\]]+)]\s+(.*)$/.exec(line);

		if (!match) {
			continue;
		}

		const parsedAt = Date.parse(match[1]);

		if (!Number.isFinite(parsedAt)) {
			continue;
		}

		if (lastSuccessAt === null && match[2].includes("Offsite backup complete")) {
			lastSuccessAt = parsedAt;
		}

		if (lastAttemptAt === null && match[2].includes("Starting offsite backup")) {
			lastAttemptAt = parsedAt;
		}

		if (lastSuccessAt !== null && lastAttemptAt !== null) {
			break;
		}
	}

	return { lastSuccessAt, lastAttemptAt };
};

const nextBackupAt = (now: number): number => {
	const next = new Date(now);

	next.setUTCHours(4, 0, 0, 0);

	if (next.getTime() <= now) {
		next.setUTCDate(next.getUTCDate() + 1);
	}

	return next.getTime();
};

const envNumber = (name: string, fallback: number): number => {
	const value = Number(process.env[name]);

	return Number.isFinite(value) ? value : fallback;
};

const reportFailure =
	<T>(errors: string[], section: string, fallback: T): ((reason: unknown) => T) =>
	() => {
		errors.push(section);

		return fallback;
	};

const readUsage = async (
	input: Parameters<typeof usageReadoutFrom>[0] & { path: string; errors: string[] },
): Promise<UsageReadout> => {
	let data: JsonRecord | null = null;

	try {
		data = await parseJsonFile(input.path);
	} catch {
		input.errors.push(`${input.slug} usage`);
	}

	return usageReadoutFrom({ ...input, data });
};

const readServices = async (
	dbPath: string,
): Promise<Omit<Dossier["services"], "stale" | "kumaUrl">> => {
	// Each active monitor with its latest heartbeat status: 0 down, 1 up, 2 pending, -1 never checked.
	const monitorSql = `SELECT m.id, m.name,
  COALESCE((SELECT h.status FROM heartbeat h WHERE h.monitor_id = m.id ORDER BY h.time DESC LIMIT 1), -1) AS status
FROM monitor m WHERE m.active = 1 ORDER BY m.name COLLATE NOCASE;`;
	const recentFailuresSql =
		"SELECT COUNT(*), COUNT(DISTINCT monitor_id) FROM heartbeat WHERE status = 0 AND time > datetime('now', '-1 hour');";
	const [monitorRows, recentFailures] = await Promise.all([
		execFileAsync("sqlite3", ["-readonly", "-json", dbPath, monitorSql]),
		execFileAsync("sqlite3", ["-readonly", dbPath, recentFailuresSql]),
	]);
	// sqlite3 -json prints nothing at all for an empty result.
	const parsed: unknown = JSON.parse(monitorRows.stdout.trim() || "[]");

	if (!Array.isArray(parsed)) {
		throw new TypeError("expected a JSON array of monitors");
	}

	const monitors = parsed.map((row: unknown) => {
		if (!isRecord(row) || typeof row.id !== "number" || typeof row.status !== "number") {
			// A changed Kuma schema must read as stale, not as an empty and therefore "All up" lab.
			throw new TypeError("unexpected Kuma monitor row");
		}

		const name = stringOrNull(row.name)?.trim() ?? "";

		return {
			id: row.id,
			name: name === "" ? `Monitor ${String(row.id)}` : name,
			status: row.status,
		};
	});
	const asCount = (value: string): number => {
		const count = Number(value);

		return Number.isFinite(count) ? count : 0;
	};

	const [failedChecks = "0", failingServices = "0"] = recentFailures.stdout.trim().split("|");

	return {
		up: monitors.filter((monitor) => monitor.status === 1).length,
		down: monitors.filter((monitor) => monitor.status === 0).map(({ id, name }) => ({ id, name })),
		pending: monitors.filter((monitor) => monitor.status === 2).length,
		totalActive: monitors.length,
		failedChecks1h: asCount(failedChecks),
		failingServices1h: asCount(failingServices),
	};
};

const readHost = async (path: string): Promise<Omit<Dossier["host"], "stale">> => {
	const raw = await parseJsonFile(path);

	if (!("disk" in raw) && !("load" in raw) && !("swap" in raw) && !("containers" in raw)) {
		throw new Error("expected at least one host-health field");
	}

	const disk = isRecord(raw.disk) ? raw.disk : {};
	const rank = (level: string): number =>
		level.startsWith("FAIL") ? 2 : level.startsWith("WARN") ? 1 : 0;
	let diskWorst: { mount: string; level: string } | null = null;

	for (const [mount, rawLevel] of Object.entries(disk)) {
		const level = stringOrNull(rawLevel);

		if (level !== null && (diskWorst === null || rank(level) > rank(diskWorst.level))) {
			diskWorst = { mount, level };
		}
	}

	const containers = isRecord(raw.containers) ? raw.containers : {};

	return {
		diskWorst,
		load: stringOrNull(raw.load) ?? "Awaiting data",
		swap: stringOrNull(raw.swap) ?? "Awaiting data",
		containerFails: Object.entries(containers).flatMap(([name, state]) =>
			stringOrNull(state)?.startsWith("FAIL") ? [name] : [],
		),
	};
};

export const buildDossier = async (): Promise<Dossier> => {
	const now = Date.now();
	const nowSeconds = Math.floor(now / 1000);
	const errors: string[] = [];
	// Royal Observatory, Greenwich. Deployments set LAB_LAT/LAB_LON.
	const lat = envNumber("LAB_LAT", 51.4769);
	const lon = envNumber("LAB_LON", -0.0005);
	const solarTimes = SunCalc.getTimes(new Date(now), lat, lon);
	const nextDaySolarTimes = SunCalc.getTimes(new Date(now + 24 * 60 * 60 * 1000), lat, lon);
	const sunriseAt = timeOf(solarTimes.sunrise);
	const sunsetAt = timeOf(solarTimes.sunset);
	const nextDaySunriseAt = timeOf(nextDaySolarTimes.sunrise);
	const nextEvent = nextSolarEvent({ sunriseAt, sunsetAt, nextDaySunriseAt }, now);
	const dawnAt = timeOf(solarTimes.dawn);
	const duskAt = timeOf(solarTimes.dusk);
	const solarNoonAt = timeOf(solarTimes.solarNoon);
	const sunPosition = SunCalc.getPosition(new Date(now), lat, lon);
	const moon = SunCalc.getMoonIllumination(new Date(now));
	const kumaBase = process.env.KUMA_URL?.replace(/\/+$/, "") ?? "";
	const kumaUrl = kumaBase === "" ? null : kumaBase;
	const defaultServices = {
		up: 0,
		down: [],
		pending: 0,
		totalActive: 0,
		failedChecks1h: 0,
		failingServices1h: 0,
		stale: true,
	};
	const defaultHost = {
		diskWorst: null,
		load: "Awaiting data",
		swap: "Awaiting data",
		containerFails: [],
		stale: true,
	};

	const [agents, backup, services, host, mood] = await Promise.all([
		Promise.all([
			readUsage({
				slug: "janet-primary",
				label: "Claude",
				kind: "claude",
				plan: process.env.CLAUDE_PLAN ?? DEFAULT_PLANS.claude,
				path: process.env.USAGE_PATH ?? "/shared/janet-usage.json",
				nowSeconds,
				errors,
				data: null,
			}),
			readUsage({
				slug: "codex",
				label: "Codex",
				kind: "codex",
				plan: process.env.CODEX_PLAN ?? DEFAULT_PLANS.codex,
				path: process.env.CODEX_USAGE_PATH ?? "/shared/codex-usage.json",
				nowSeconds,
				errors,
				data: null,
			}),
		]),
		readFile(process.env.BACKUP_LOG ?? "/logs/backup-offsite.log", "utf8")
			.then(parseBackupLog)
			.catch(reportFailure(errors, "backup", { lastSuccessAt: null, lastAttemptAt: null })),
		readServices(process.env.KUMA_DB ?? "/kuma/kuma.db")
			.then((value) => ({ ...value, stale: false }))
			.catch(reportFailure(errors, "services", defaultServices)),
		readHost(process.env.HOST_HEALTH_PATH ?? "/shared/host-health-state.json")
			.then((value) => ({ ...value, stale: false }))
			.catch(reportFailure(errors, "host", defaultHost)),
		parseJsonFile(process.env.MOOD_PATH ?? "/shared/janet-mood.json")
			.then((value) => ({
				mood: stringOrNull(value.mood) ?? "Quiet",
				quote: stringOrNull(value.quote) ?? "No reading yet.",
			}))
			.catch(reportFailure(errors, "mood", { mood: "Quiet", quote: "No reading yet." })),
	]);
	const phase = moon.phase;
	const dayFraction =
		sunriseAt === null || sunsetAt === null || sunsetAt <= sunriseAt
			? 0
			: Math.max(0, Math.min(1, (now - sunriseAt) / (sunsetAt - sunriseAt)));

	return {
		now,
		sun: {
			sunriseAt,
			sunsetAt,
			nextDaySunriseAt,
			nextEvent,
			dawnAt,
			duskAt,
			solarNoonAt,
			altitudeDeg: sunPosition.altitude,
			azimuthDeg: sunPosition.azimuth,
			dayFraction,
			phase: solarPhaseName({ dawnAt, sunriseAt, solarNoonAt, sunsetAt, duskAt }, now),
		},
		moon: {
			phase,
			illumination: moon.fraction,
			ageDays: moonAgeDays(phase),
			phaseName: moonPhaseName(phase),
		},
		agents: [agents[0], agents[1]],
		backup: {
			...backup,
			nextScheduledAt: nextBackupAt(now),
			stale: backup.lastSuccessAt === null || now - backup.lastSuccessAt > BACKUP_STALE_AFTER_MS,
		},
		services: { ...services, kumaUrl },
		host,
		mood,
		debug: { errors },
	};
};
