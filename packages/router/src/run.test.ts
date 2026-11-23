import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { classify, redact } from "./adapters.ts";
import { resolveTarget } from "./policy.ts";
import { run } from "./run.ts";
import { appendEvent, seedLedger, validateLedger } from "./state.ts";
import { readCodexSession } from "./telemetry.ts";

const dirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
	dirs.length = 0;
});

async function fixture() {
	const dir = await mkdtemp(path.join(tmpdir(), "router-run-"));

	dirs.push(dir);
	const injectPath = path.join(dir, "inject");

	await writeFile(
		injectPath,
		`#!/bin/sh\nprintf '%s\\n' "$*" >> '${dir}/injections'\ncat >> '${dir}/injections'\n`,
		{ mode: 0o700 },
	);

	const target = resolveTarget("gpt-test:low");

	if (!target) {
		throw new Error("fixture missing target");
	}

	return {
		target,
		runId: crypto.randomUUID(),
		brief: "Reply with exactly: ok",
		cwd: dir,
		dir,
		legacy: path.join(dir, "legacy"),
		injectPath,
	};
}

async function events(dir: string) {
	return (await readFile(path.join(dir, "ledger.jsonl"), "utf8"))
		.trim()
		.split("\n")
		.map((line) => {
			const value: unknown = JSON.parse(line);

			if (!value || typeof value !== "object") {
				throw new Error("invalid event");
			}

			return Object.fromEntries(Object.entries(value)) as Record<string, unknown>;
		});
}

it.each(["", "What would you like to work on?"])(
	"stops empty/sentinel output without retry",
	async (out) => {
		const options = await fixture();
		let count = 0;
		const result = await run({
			...options,
			launch: () => {
				count++;

				return { code: 0, out, log: "" };
			},
		});

		expect(result.code).toBe(1);
		expect(count).toBe(1);
	},
);

it("redacts complete output before taking the injection tail", async () => {
	const options = await fixture();
	const secret = `sk-${"x".repeat(40)}`;

	await run({
		...options,
		launch: () => ({
			code: 0,
			out: `ok api_key=example-secret ${secret}\n-----BEGIN PRIVATE KEY-----\n${"x".repeat(5000)}\n-----END PRIVATE KEY-----`,
			log: `Authorization: Bearer ${secret}`,
		}),
	});

	const injection = await readFile(path.join(options.dir, "injections"), "utf8");

	expect(injection).not.toContain(secret);
	expect(injection).not.toContain("example-secret");
	expect(injection).not.toContain("x".repeat(30));
	expect(injection.match(/--source route --key/gu)).toHaveLength(1);
});

it("seeds legacy metadata only, once, even with concurrent runs", async () => {
	const options = await fixture();

	await mkdir(options.legacy);

	await writeFile(
		path.join(options.legacy, "old.log"),
		"started 2026-11-19T00:00:00Z model=gemini-test workdir=/private\nsecret=do-not-import\nended 2026-11-19T00:01:00Z rc=0\n",
	);

	await Promise.all([
		seedLedger(options.dir, options.legacy),
		seedLedger(options.dir, options.legacy),
	]);

	const rows = await events(options.dir);

	expect(rows.filter((r) => r["event"] === "import")).toHaveLength(1);
	expect(JSON.stringify(rows)).not.toContain("do-not-import");
	expect(rows[0]?.["kind"]).toBeNull();
});

it("records distinct sessions, paired snapshots and provenance for reused briefs", async () => {
	const options = await fixture();
	let quotaReads = 0;
	let launches = 0;
	const args = {
		...options,
		promiseId: 17,
		sourceKind: "human" as const,
		readQuota: () =>
			Promise.resolve({
				service: "codex" as const,
				status: "ok" as const,
				summary: "",
				limits: [{ id: "codex:5h", label: "", usedPct: ++quotaReads }],
			}),
		launch: () => ({
			code: 0,
			out: "checked",
			log: "",
			telemetry: {
				nativeSessionId: `session-${String(++launches)}`,
				respondingModel: "gpt-observed",
				usage: null,
				cost: { charge: null, apiEquivalent: null, planOpportunity: null },
			},
		}),
	};
	const first = await run(args);
	const second = await run({ ...args, runId: crypto.randomUUID() });
	const outcomes = (await events(options.dir)).filter((r) => r["event"] === "outcome");

	expect(outcomes).toMatchObject([
		{
			runId: first.runId,
			attempt: 1,
			nativeSessionId: "session-1",
			respondingModel: "gpt-observed",
			sourceKind: "human",
			acceptanceRef: "promise:17",
			artifactRevision: null,
			quotaBefore: { windows: [{ usedPct: 1 }] },
			quotaAfter: { windows: [{ usedPct: 2 }] },
		},
		{
			runId: second.runId,
			attempt: 1,
			nativeSessionId: "session-2",
			quotaBefore: { windows: [{ usedPct: 3 }] },
			quotaAfter: { windows: [{ usedPct: 4 }] },
		},
	]);

	expect(await readFile(path.join(options.dir, "injections"), "utf8")).toContain(
		"promise acceptance 17",
	);
});

it("uses the exact Codex rollout and records a weekly primary window", async () => {
	const { dir } = await fixture();
	const at = Date.parse("2026-11-23T18:30:00Z");
	const day = path.join(dir, "2026/11/23");

	await mkdir(day, { recursive: true });

	const quota = {
		limit_id: "codex",
		primary: { window_minutes: 10080, used_percent: 10, resets_at: 1796000000 },
	};

	await writeFile(
		path.join(day, "rollout-date-session-one.jsonl"),
		[
			{ type: "turn_context", payload: { model: "gpt-observed" } },
			{
				type: "event_msg",
				timestamp: new Date(at).toISOString(),
				payload: { type: "token_count", rate_limits: quota },
			},
		]
			.map((event) => JSON.stringify(event))
			.join("\n"),
	);

	await writeFile(
		path.join(day, "rollout-date-session-two.jsonl"),
		'{"type":"turn_context","payload":{"model":"another-model"}}\n',
	);

	expect(await readCodexSession(dir, "session-one", at)).toMatchObject({
		respondingModel: "gpt-observed",
		quota: { at, report: { limits: [{ id: "codex:7d", usedPct: 10 }] } },
	});

	expect(await readCodexSession(dir, "missing", at)).toEqual({
		respondingModel: null,
		quota: null,
	});
});

it("redacts values before JSON encoding and isolates a damaged historical tail", async () => {
	const { dir } = await fixture();
	const file = path.join(dir, "ledger.jsonl");

	await writeFile(file, '{"event":');

	await appendEvent(dir, {
		event: "outcome",
		briefName: 'token="secret with \\ and\t space"\nbrief',
		details: {
			authorization: "private",
			client_secret: "private-value",
			inputTokens: 37,
			reset: null,
		},
	});

	const rows = (await readFile(file, "utf8")).split("\n");

	expect(await validateLedger(file)).toEqual({ count: 2, invalid: [1] });

	expect(JSON.parse(rows[1] ?? "")).toEqual({
		event: "outcome",
		briefName: 'token="[REDACTED]"\nbrief',
		details: {
			authorization: "[REDACTED]",
			client_secret: "[REDACTED]",
			inputTokens: 37,
			reset: null,
		},
	});
});

it("does not classify successful prose about failures as failed execution", () => {
	for (const out of [
		"HTTP authentication uses a 401 status.",
		"The server returns 429 when over quota.",
		"There are 500 records.",
	]) {
		expect(classify({ code: 0, out, log: "" })).toBeNull();
	}

	expect(redact('password="two word secret"')).not.toContain("word secret");
});

it.each([
	["429 RESOURCE_EXHAUSTED", "quota"],
	["usage limit reached", "quota"],
	["rate limit reached", "quota"],
	["quota exceeded", "quota"],
	["model_not_found", "bad-offer"],
	["401 authentication failed", "auth"],
	["503 interrupted", "transient"],
] as const)("classifies %s only on adapter error lines", (message, expected) => {
	for (const prefix of ["AGY_ERROR:", "ERROR:"]) {
		expect(classify({ code: 1, out: "", log: `${prefix} ${message}` })).toBe(expected);
		expect(classify({ code: 1, out: `${prefix} ${message}`, log: "" })).toBe("unknown");
		expect(classify({ code: 1, out: "", log: `builder: ${prefix} ${message}` })).toBe("unknown");
		expect(classify({ code: 0, out: "ok", log: `${prefix} ${message}` })).toBeNull();
	}
});
