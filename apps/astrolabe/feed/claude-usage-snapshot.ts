#!/usr/bin/env node
// Writes Claude Code's usage to the shared feed the Astrolabe dashboard reads (`USAGE_PATH`).
//
// It runs usage-fetch.js, which asks claude.ai for an organization's usage with the session key in
// ~/.config/claude-matrix-channel/usage.toml and prints the response, each window's exact
// `resets_at` included, so nothing here is estimated.
//
// Cron runs it every 2 minutes from a release checkout of main:
//     */2 * * * * <release>/apps/astrolabe/feed/claude-usage-snapshot.ts >/dev/null 2>&1
//
// No dependencies, so Node runs it from the source tree by stripping its types.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

type JsonRecord = Record<string, unknown>;

const FETCHER = "/home/docker/.claude/bin/usage-fetch.js";
const MOOD = "/tmp/janet-mood.json";
const CREDENTIALS = path.join(homedir(), ".claude", ".credentials.json");
const OUT = process.env.CLAUDE_USAGE_OUT ?? "/home/docker/.claude/shared/janet-usage.json";
const AGENT_VM = "agent@10.10.10.202";
const AGENT_VM_OUT = "/home/agent/.claude/shared/janet-usage.json";

const FIVE_HOURS_SECONDS = 5 * 60 * 60;

/** The 5-hour window's mark, by percent used. */
const EMOJIS: [atLeast: number, emoji: string][] = [
	[95, "🔴"],
	[80, "🟠"],
	[50, "🟡"],
];

const isRecord = (value: unknown): value is JsonRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** A window of the usage response, which is null or missing when the plan has no such window. */
const recordOf = (value: unknown): JsonRecord => (isRecord(value) ? value : {});

/** The JSON object in a file, or an empty one when the file is missing or holds anything else. */
const readRecord = (file: string): JsonRecord => {
	try {
		return recordOf(JSON.parse(readFileSync(file, "utf8")));
	} catch {
		return {};
	}
};

/**
 * The plan of the Claude Code login, which the usage response does not name. Only these two fields
 * leave the credentials file; its tokens never reach the snapshot. A missing login leaves both
 * null. The usage is read with a claude.ai session key instead, and nothing checks that the two are
 * one account.
 */
const claudePlan = () => {
	const oauth = recordOf(readRecord(CREDENTIALS).claudeAiOauth);

	return {
		subscription_type: oauth.subscriptionType ?? null,
		rate_limit_tier: oauth.rateLimitTier ?? null,
	};
};

/** Returns the exit code. */
const main = (): number => {
	const fetched = spawnSync("node", [FETCHER], { encoding: "utf8", timeout: 15_000 });

	if (fetched.error !== undefined || fetched.status !== 0) {
		console.error(`[usage-snapshot] fetcher failed: ${fetched.error?.message ?? fetched.stderr}`);

		return 2;
	}

	let body: unknown;

	try {
		body = JSON.parse(fetched.stdout);
	} catch (error) {
		console.error(`[usage-snapshot] bad json: ${String(error)}`);

		return 2;
	}

	if (!isRecord(body)) {
		console.error("[usage-snapshot] bad json: not an object");

		return 2;
	}

	const fiveHour = recordOf(body.five_hour);
	const sevenDay = recordOf(body.seven_day);
	const pct = typeof fiveHour.utilization === "number" ? Math.trunc(fiveHour.utilization) : 0;
	// Such as 2026-05-17T18:09:59.943531+00:00. A response without a 5-hour window gives 0.
	const resetsIso = typeof fiveHour.resets_at === "string" ? fiveHour.resets_at : null;
	const resetsAt = resetsIso === null ? 0 : Math.floor(Date.parse(resetsIso) / 1000) || 0;
	const now = Math.floor(Date.now() / 1000);
	const resetsIn = Math.max(0, resetsAt - now);
	const emoji = EMOJIS.find(([atLeast]) => pct >= atLeast)?.[1] ?? "🟢";
	const snapshot = JSON.stringify(
		{
			name: "Janet",
			mxid: "@janet:mx.petalcat.dev",
			five_hour_pct: pct,
			five_hour_resets_at: resetsAt,
			five_hour_resets_at_iso: resetsIso,
			seven_day_pct: sevenDay.utilization ?? null,
			seven_day_resets_at_iso: sevenDay.resets_at ?? null,
			seven_day_opus_pct: recordOf(body.seven_day_opus).utilization ?? null,
			seven_day_sonnet_pct: recordOf(body.seven_day_sonnet).utilization ?? null,
			...claudePlan(),
			emoji,
			window_started_at: resetsAt === 0 ? now : resetsAt - FIVE_HOURS_SECONDS,
			window_resets_at: resetsAt,
			resets_in_seconds: resetsIn,
			mood: readRecord(MOOD).mood ?? "unknown",
			scraped_at: now,
			source: "claude.ai/api/.../usage (node fetcher)",
			raw: body,
		},
		null,
		2,
	);

	writeFileSync(OUT, snapshot);

	// The live Janet session on the agent VM reads its own budget from this copy, through
	// ~/.claude/bin/usage. A VM that is down must not fail the local snapshot, so the result is not
	// checked.
	spawnSync(
		"ssh",
		[
			"-o",
			"BatchMode=yes",
			"-o",
			"ConnectTimeout=5",
			AGENT_VM,
			`cat > ${AGENT_VM_OUT}.tmp && mv ${AGENT_VM_OUT}.tmp ${AGENT_VM_OUT}`,
		],
		{ input: snapshot, timeout: 15_000, stdio: ["pipe", "ignore", "ignore"] },
	);

	const week = typeof sevenDay.utilization === "number" ? String(sevenDay.utilization) : "?";
	const hours = String(Math.floor(resetsIn / 3600));
	const minutes = String(Math.floor((resetsIn % 3600) / 60)).padStart(2, "0");

	console.log(
		`[usage-snapshot] 5h: ${String(pct)}% ${emoji}, resets in ${hours}h${minutes}m  | 7d: ${week}%`,
	);

	return 0;
};

process.exitCode = main();
