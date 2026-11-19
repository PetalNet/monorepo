import assert from "node:assert/strict";

import { snapshot } from "./agents-snapshot.mjs";

const now = Date.parse("2026-01-03T12:00:00Z");
const at = "2026-01-03T11:00:00Z";
const events = [
	{
		event: "launch",
		runId: "public",
		at,
		dataClass: "public",
		briefName: "/home/alice/redact.txt",
		model: "model",
		kind: "code",
		tier: "A",
		pool: "codex",
	},
	{ event: "outcome", runId: "public", at, endedAt: "2026-01-03T11:01:00Z", exitCode: 0 },
	{ event: "launch", runId: "sensitive", at, dataClass: "sensitive", briefName: "sensitive.txt" },
	{ event: "outcome", runId: "sensitive", at, exitCode: 1, failureClass: "timeout" },
	{ event: "launch", runId: "private", at, dataClass: "parcs", briefName: "private.txt" },
	{ event: "outcome", runId: "private", at, exitCode: 0 },
	{ event: "launch", runId: "unknown", at },
	{ event: "outcome", runId: "unknown", at, exitCode: 0 },
	{ event: "launch", runId: "conflict", at, dataClass: "public" },
	{ event: "launch", runId: "conflict", at, dataClass: "parcs" },
	{ event: "launch", runId: "retry", at, dataClass: "public", model: "first", attempt: 1 },
	{ event: "outcome", runId: "retry", at, exitCode: 1, failureClass: "quota", attempt: 1 },
	{ event: "attempt", runId: "retry", at, model: "second", attempt: 2 },
	{ event: "outcome", runId: "retry", at, exitCode: 0, attempt: 2 },
	{
		event: "launch",
		runId: "running",
		at,
		dataClass: "public",
		briefName: "alice@example.com",
		model: "ghp_metadata",
	},
	{ event: "launch", runId: "old", at: "2025-12-30T00:00:00Z", dataClass: "public" },
	{ event: "outcome", runId: "old", at: "2025-12-30T00:00:00Z", exitCode: 0 },
	{ event: "launch", runId: "../escape", at, dataClass: "public" },
];
const files = new Map([
	["/state/ledger.jsonl", events.map(JSON.stringify).join("\n")],
	[
		"/state/runs/public.events.jsonl",
		[
			{
				type: "item.completed",
				item: {
					id: "1",
					type: "agent_message",
					text: "email alice@example.com at /home/alice/project key=ok",
				},
			},
			{
				type: "item.completed",
				item: {
					id: "2",
					type: "command_execution",
					command: "cat /Users/bob/file",
					aggregated_output: "Bearer abc123",
					exit_code: 0,
				},
			},
		]
			.map(JSON.stringify)
			.join("\n"),
	],
	[
		"/state/runs/public.out",
		"Done https://github.com/example/repo/pull/12 token=ghp_abcdef alice@example.com",
	],
	[
		"/state/runs/sensitive.log",
		[
			{
				event: "step_update",
				step_update: {
					step_type: "agent_response",
					step_index: 1,
					state: "DONE",
					text_delta: "hello from agy",
				},
			},
			{
				type: "assistant",
				uuid: "1",
				message: { content: [{ type: "text", text: "hello from claude" }] },
			},
		]
			.map(JSON.stringify)
			.join("\n"),
	],
	["/state/runs/sensitive.out", "password=secret-value token=short-token"],
]);
const reads = [];

async function read(path) {
	reads.push(path);

	if (files.has(path)) return files.get(path);

	throw Object.assign(new Error("missing"), { code: "ENOENT" });
}

const result = await snapshot({ stateDir: "/state", now, read });

assert.equal(result.updatedAt, new Date(now).toISOString());

assert.ok(
	result.runs.findIndex((run) => run.id === "running") <
		result.runs.findIndex((run) => run.id === "public"),
);

assert.equal(
	result.runs.some((run) => run.id === "old" || run.id === "../escape"),
	false,
);

for (const id of ["private", "unknown", "conflict"]) {
	assert.equal(
		reads.some((path) => path.startsWith(`/state/runs/${id}.`)),
		false,
	);

	const run = result.runs.find((item) => item.id === id);

	assert.deepEqual(run.turns, []);
	assert.equal(run.output, "");
	assert.deepEqual(run.links, []);
}

assert.equal(result.runs.find((run) => run.id === "conflict").dataClass, "unknown");
const publicRun = result.runs.find((run) => run.id === "public");

assert.equal(publicRun.name, "redact.txt");
assert.equal(publicRun.status, "done");
assert.equal(publicRun.pool, "codex");
assert.deepEqual(publicRun.links, ["https://github.com/example/repo/pull/12"]);
assert.equal(publicRun.turns.length, 2);
assert.match(publicRun.turns[0].text, /\[email\].*\/home\/\[user\]\/project/);
assert.match(publicRun.turns[1].text, /\/Users\/\[user\]\/file/);
assert.match(publicRun.turns[1].result, /Bearer \[redacted\]/);

assert.doesNotMatch(
	JSON.stringify(result),
	/alice@example|\/home\/alice|\/Users\/bob|ghp_abcdef|secret-value|short-token/,
);

const sensitive = result.runs.find((run) => run.id === "sensitive");

assert.equal(sensitive.status, "timed out");

assert.deepEqual(
	sensitive.turns.map((turn) => turn.text),
	["hello from agy", "hello from claude"],
);

const retry = result.runs.find((run) => run.id === "retry");

assert.equal(retry.status, "fell back");

assert.deepEqual(
	retry.attempts.map(({ model, failureClass }) => [model, failureClass]),
	[
		["first", "quota"],
		["second", ""],
	],
);

assert.equal(result.runs.find((run) => run.id === "running").name, "[email]");
assert.equal(result.runs.find((run) => run.id === "running").model, "[redacted]");
assert.equal(reads.includes("/state/runs/running.out"), false);
assert.equal(reads.includes("/state/runs/running.log"), false);

await assert.rejects(
	snapshot({
		stateDir: "/state",
		now,
		read: async () => {
			throw Object.assign(new Error("denied"), { code: "EACCES" });
		},
	}),
	/denied/,
);

console.log("agents snapshot synthetic tests passed");
