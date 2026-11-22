#!/usr/bin/env node
// Reads Codex's rate-limit usage as OpenAI reports it. It asks live first, through
// `codex app-server` (no model call, no tokens spent), and falls back to the newest session rollout
// under ~/.codex/sessions, where the Codex CLI records the API's `rate_limits` on every turn.
// Windows are told apart by their length (5 hours or 7 days), not by the primary or secondary slot.
//
// Prints a summary for a person and exits 3 when a limit has stopped requests, so a caller can
// back off. With --json it prints the snapshot `snapshot` returns and exits 0.
//
// No dependencies outside this package, so Node runs it from the source tree by stripping its types.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { globSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import { formatDuration } from "../src/lib/format.ts";

type JsonRecord = Record<string, unknown>;

interface Reading {
	/** OpenAI's rate limits in the shape a rollout records them, snake_case. */
	limits: JsonRecord;
	/** Epoch seconds the limits were true at. */
	observedAt: number;
}

const LIVE_DEADLINE_MS = 20_000;

/** A window this long or longer is the weekly one. */
const DAY_MINUTES = 24 * 60;

/** How many of the newest rollouts are searched, since the very latest may record no limits. */
const ROLLOUTS_SEARCHED = 8;

const isRecord = (value: unknown): value is JsonRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const recordOf = (value: unknown): JsonRecord => (isRecord(value) ? value : {});

/** A figure Codex gives as a number or, for the credit balance, as a decimal string. */
const numberOrNull = (value: unknown): number | null => {
	const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;

	return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
};

const nowSeconds = () => Date.now() / 1000;

/** Every `rate_limits` object in a rollout line, in the order the line holds them. */
function* rateLimitsIn(value: unknown): Generator<JsonRecord> {
	if (Array.isArray(value)) {
		for (const item of value) {
			yield* rateLimitsIn(item);
		}

		return;
	}

	if (!isRecord(value)) {
		return;
	}

	for (const [key, item] of Object.entries(value)) {
		if (key === "rate_limits" && isRecord(item)) {
			yield item;
		} else {
			yield* rateLimitsIn(item);
		}
	}
}

/** The last rate limits the newest rollouts record, as old as the rollout that holds them. */
const rolloutRateLimits = (): Reading | null => {
	const sessions = path.join(homedir(), ".codex", "sessions");
	const rollouts = globSync("**/*.jsonl", { cwd: sessions })
		.map((name) => {
			const file = path.join(sessions, name);

			return { file, modifiedAt: statSync(file).mtimeMs / 1000 };
		})
		.toSorted((a, b) => b.modifiedAt - a.modifiedAt);

	for (const { file, modifiedAt } of rollouts.slice(0, ROLLOUTS_SEARCHED)) {
		let limits: JsonRecord = {};

		try {
			for (const line of readFileSync(file, "utf8").split("\n")) {
				try {
					limits = Array.from(rateLimitsIn(JSON.parse(line))).at(-1) ?? limits;
				} catch {
					// A line that is not JSON, such as one cut off mid-write, records nothing.
				}
			}
		} catch {
			continue;
		}

		if (Object.keys(limits).length > 0) {
			return { limits, observedAt: modifiedAt };
		}
	}

	return null;
};

/**
 * The rate limits OpenAI answers `account/rateLimits/read` with, in the rollout's shape. Rollouts
 * only change when Codex is used, so an idle host would otherwise report figures hours old.
 */
const liveRateLimits = async (): Promise<JsonRecord | null> => {
	const requests = [
		{
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { clientInfo: { name: "codex-usage", version: "1" } },
		},
		{ jsonrpc: "2.0", method: "initialized" },
		{ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read" },
	];
	const server = spawn(process.env.CODEX_BIN ?? "codex", ["app-server"], {
		stdio: ["pipe", "pipe", "ignore"],
	});

	try {
		await once(server, "spawn");
	} catch (error) {
		console.error(`codex-usage: live read unavailable (${String(error)}); using rollouts`);

		return null;
	}

	server.stdin.on("error", () => {
		// A server that exits before reading the requests leaves no reply, which is reported below.
	});

	server.stdin.write(requests.map((request) => `${JSON.stringify(request)}\n`).join(""));

	// The server stays up after it answers, so the wait for its reply ends at a deadline.
	const replies = createInterface({
		input: server.stdout,
		signal: AbortSignal.timeout(LIVE_DEADLINE_MS),
	});

	try {
		for await (const line of replies) {
			let reply: unknown;

			try {
				reply = JSON.parse(line);
			} catch {
				continue;
			}

			if (!isRecord(reply) || reply.id !== 2) {
				continue;
			}

			const limits = recordOf(reply.result).rateLimits;

			if (!isRecord(limits)) {
				break;
			}

			const window = (value: unknown) =>
				isRecord(value)
					? {
							used_percent: value.usedPercent,
							window_minutes: value.windowDurationMins,
							resets_at: value.resetsAt,
						}
					: null;
			const credits = recordOf(limits.credits);

			return {
				primary: window(limits.primary),
				secondary: window(limits.secondary),
				credits: { balance: credits.balance, has_credits: credits.hasCredits },
				plan_type: limits.planType,
				rate_limit_reached_type: limits.rateLimitReachedType,
			};
		}
	} finally {
		server.kill("SIGKILL");
		server.stdin.destroy();
		server.stdout.destroy();
	}

	console.error("codex-usage: live read failed; using rollouts");

	return null;
};

const currentRateLimits = async (): Promise<Reading | null> => {
	const limits = await liveRateLimits();

	return limits === null ? rolloutRateLimits() : { limits, observedAt: nowSeconds() };
};

/**
 * The 5-hour and weekly windows. Some plans report the weekly window as `primary` with no
 * `secondary`, so the slot says nothing.
 */
const windowsOf = (limits: JsonRecord): { short: JsonRecord; week: JsonRecord } => {
	const windows = { short: {}, week: {} };

	for (const window of [limits.primary, limits.secondary]) {
		if (isRecord(window)) {
			windows[(numberOrNull(window.window_minutes) ?? 0) >= DAY_MINUTES ? "week" : "short"] =
				window;
		}
	}

	return windows;
};

/** A reset in whole epoch seconds. Codex gives 0 for a window with none. */
const resetOf = (window: JsonRecord): number | null => {
	const resetsAt = numberOrNull(window.resets_at);

	return resetsAt === null || resetsAt === 0 ? null : Math.trunc(resetsAt);
};

/**
 * The snapshot `CODEX_USAGE_PATH` holds, which `src/lib/server/dossier.ts` reads. A window OpenAI
 * has not reported has a null `_pct` and `_resets_at`.
 */
export const snapshot = async (): Promise<JsonRecord> => {
	const reading = await currentRateLimits();
	const scrapedAt = Math.trunc(nowSeconds());

	if (reading === null) {
		return {
			five_hour_pct: null,
			five_hour_resets_at: null,
			seven_day_pct: null,
			seven_day_resets_at: null,
			plan: null,
			scraped_at: scrapedAt,
			snapshot_age_sec: null,
			awaiting: true,
		};
	}

	const { limits, observedAt } = reading;
	const { short, week } = windowsOf(limits);
	const credits = recordOf(limits.credits);

	return {
		five_hour_pct: numberOrNull(short.used_percent),
		five_hour_resets_at: resetOf(short),
		seven_day_pct: numberOrNull(week.used_percent),
		seven_day_resets_at: resetOf(week),
		plan: limits.plan_type ?? null,
		scraped_at: scrapedAt,
		snapshot_age_sec: Math.max(0, Math.trunc(scrapedAt - observedAt)),
		awaiting: false,
		credits_balance: numberOrNull(credits.balance),
		// OpenAI's own word that credits are carrying requests past a full window.
		has_credits: credits.has_credits ?? null,
		// Set only when a limit has stopped requests; at 100% with credits it stays null.
		rate_limit_reached_type: limits.rate_limit_reached_type ?? null,
	};
};

/** Prints the summary for a person. Returns the exit code: 3 when a limit has stopped requests. */
const report = async (): Promise<number> => {
	const reading = await currentRateLimits();

	if (reading === null) {
		console.log("codex usage: no rate-limit data yet (make a codex call first)");

		return 0;
	}

	const { limits, observedAt } = reading;
	const { short, week } = windowsOf(limits);
	const used = (window: JsonRecord) => String(numberOrNull(window.used_percent) ?? "?");
	const reset = (window: JsonRecord) => {
		const resetsAt = resetOf(window);

		return resetsAt === null ? "?" : formatDuration((resetsAt - nowSeconds()) * 1000);
	};

	const age = String(Math.max(0, Math.trunc(nowSeconds() - observedAt)));
	const plan = typeof limits.plan_type === "string" ? limits.plan_type : "?";

	console.log(`Codex usage (plan: ${plan}; snapshot ${age}s ago):`);
	console.log(`  5-hour window : ${used(short)}% used   (resets in ${reset(short)})`);
	console.log(`  weekly window : ${used(week)}% used   (resets in ${reset(week)})`);

	if (typeof limits.rate_limit_reached_type === "string") {
		console.log(`  ⚠ LIMIT REACHED: ${limits.rate_limit_reached_type}`);

		return 3;
	}

	const highest = Math.max(
		numberOrNull(short.used_percent) ?? 0,
		numberOrNull(week.used_percent) ?? 0,
	);

	if (highest >= 90) {
		console.log(`  ⚠ near limit (${String(highest)}%) — back off`);
	}

	return 0;
};

if (import.meta.main) {
	if (process.argv.includes("--json")) {
		console.log(JSON.stringify(await snapshot()));
	} else {
		process.exitCode = await report();
	}
}
