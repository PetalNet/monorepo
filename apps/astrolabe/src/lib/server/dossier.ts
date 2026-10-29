import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import * as SunCalc from "suncalc";

import type { ServiceCounts } from "../services.js";
import { nextSolarEvent, type SolarEvent } from "../sky.js";

const execFileAsync = promisify(execFile);
const FIFTEEN_MINUTES_SECONDS = 15 * 60;
const BACKUP_STALE_AFTER_MS = 26 * 60 * 60 * 1000;
const SYNODIC_MONTH_DAYS = 29.53058867;

export interface UsageReadout {
	slug: "janet-primary" | "codex";
	label: "Claude" | "Codex";
	kind: "claude" | "codex";
	/**
	 * Percent of the 5-hour limit used (Claude's `utilization`, Codex's `used_percent`), not percent
	 * left.
	 */
	fiveHourUsedPct: number | null;
	fiveHourResetsAt: number | null;
	/** Percent of the 7-day limit used, not percent left. */
	sevenDayUsedPct: number | null;
	sevenDayResetsAt: number | null;
	creditsBalance: number | null;
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
	services: ServiceCounts & { totalActive: number };
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

/** @internal Exported for its tests; buildDossier is the module's interface. */
export const usageReadoutFrom = (input: {
	slug: UsageReadout["slug"];
	label: UsageReadout["label"];
	kind: UsageReadout["kind"];
	data: JsonRecord | null;
	nowSeconds: number;
}): UsageReadout => {
	const { slug, label, kind, data, nowSeconds } = input;
	const awaiting = kind === "codex" && (data === null || data.awaiting === true);
	const scrapedAt = data === null ? null : numberOrNull(data.scraped_at);
	const fiveHourResetsAt = data === null ? null : numberOrNull(data.five_hour_resets_at);
	const sevenDayResetsAt =
		data === null
			? null
			: kind === "claude"
				? epochSecondsFromIso(data.seven_day_resets_at_iso)
				: numberOrNull(data.seven_day_resets_at);

	return {
		slug,
		label,
		kind,
		fiveHourUsedPct: data === null ? null : pct(data.five_hour_pct),
		fiveHourResetsAt,
		sevenDayUsedPct: data === null ? null : pct(data.seven_day_pct),
		sevenDayResetsAt,
		creditsBalance: kind === "codex" && data !== null ? numberOrNull(data.credits_balance) : null,
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

const readServices = async (dbPath: string): Promise<Omit<Dossier["services"], "stale">> => {
	const monitorSql = `SELECT
  SUM(CASE WHEN s = 1 THEN 1 ELSE 0 END) AS up,
  SUM(CASE WHEN s = 0 THEN 1 ELSE 0 END) AS down,
  SUM(CASE WHEN s = 2 THEN 1 ELSE 0 END) AS pending,
  COUNT(*) AS total
FROM (
  SELECT COALESCE((SELECT h.status FROM heartbeat h WHERE h.monitor_id = m.id ORDER BY h.time DESC LIMIT 1), -1) AS s
  FROM monitor m WHERE m.active = 1
);`;
	const recentFailuresSql =
		"SELECT COUNT(*), COUNT(DISTINCT monitor_id) FROM heartbeat WHERE status = 0 AND time > datetime('now', '-1 hour');";
	const [monitors, recentFailures] = await Promise.all([
		execFileAsync("sqlite3", ["-readonly", dbPath, monitorSql]),
		execFileAsync("sqlite3", ["-readonly", dbPath, recentFailuresSql]),
	]);
	const [up = "0", down = "0", pending = "0", total = "0"] = monitors.stdout.trim().split("|");
	const asCount = (value: string): number => {
		const count = Number(value);

		return Number.isFinite(count) ? count : 0;
	};

	const [failedChecks = "0", failingServices = "0"] = recentFailures.stdout.trim().split("|");

	return {
		up: asCount(up),
		down: asCount(down),
		pending: asCount(pending),
		totalActive: asCount(total),
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
	const defaultServices = {
		up: 0,
		down: 0,
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
				path: process.env.USAGE_PATH ?? "/shared/janet-usage.json",
				nowSeconds,
				errors,
				data: null,
			}),
			readUsage({
				slug: "codex",
				label: "Codex",
				kind: "codex",
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
		services,
		host,
		mood,
		debug: { errors },
	};
};
