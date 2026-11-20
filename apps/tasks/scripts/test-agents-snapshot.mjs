import assert from "node:assert/strict";

import { snapshot } from "./agents-snapshot.mjs";
import { redact } from "./agents-view/safe.ts";

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

async function read(filePath) {
	reads.push(filePath);

	if (files.has(filePath)) {
		return files.get(filePath);
	}

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
		reads.some((filePath) => filePath.startsWith(`/state/runs/${id}.`)),
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

// Synthetic export-boundary redaction regressions and identifier preservation.
const secretCases = [
	['password="two word secret"', 'password="[redacted]"'],
	["password='two word secret'", "password='[redacted]'"],
	["token=`two word token`", "token=`[redacted]`"],
	['{"secret": "two word json secret"}', '{"secret": "[redacted]"}'],
	["SECRET_KEY=synthetic-secret-value", "SECRET_KEY=[redacted]"],
	['SECRET_KEY="multi word key"', 'SECRET_KEY="[redacted]"'],
	["API_KEY=synthetic-api-key", "API_KEY=[redacted]"],
	["eyJheader.eyJpayload.sig123", "[redacted]"],
	["eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjMifQ.", "[redacted]"],
	["AKIA0123456789ABCDEF", "[redacted]"],
	["Authorization: Basic dXNlcjpwYXNz", "Authorization: Basic [redacted]"],
	["Proxy-Authorization: Basic dXNlcjpwYXNz", "Proxy-Authorization: Basic [redacted]"],
	["Authorization: Token synthetic-token", "Authorization: Token [redacted]"],
	["Authorization: Bearer synthetic-jwt", "Authorization: Bearer [redacted]"],
	["https://admin:hunter2@192.168.1.1/api", "https://[redacted]@192.168.1.1/api"],
	["http://admin:hunter2@[::1]:8080/api", "http://[redacted]@[::1]:8080/api"],
	["redis://:hunter2@127.0.0.1:6379", "redis://[redacted]@127.0.0.1:6379"],
	["-----BEGIN PRIVATE KEY-----\nshortline1\nshortline2\n-----END PRIVATE KEY-----", "[redacted]"],
	[
		"-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0123456789abcdef0123456789abcdef0123456789abcdef\ntrail\n-----END RSA PRIVATE KEY-----",
		"[redacted]",
	],
	["sk-proj-synthetic12345", "[redacted]"],
	["github_pat_synthetic12345", "[redacted]"],
	["glpat-synthetic12345", "[redacted]"],
	["AIzaSyntheticKey12345", "[redacted]"],
	["xoxb-123-456-synthetic", "[redacted]"],
	[`npm_${"aB3dE6gH9jK2mN5pQ8rS".repeat(2).slice(0, 36)}`, "[redacted]"],
];

for (const [raw, expected] of secretCases) {
	assert.equal(redact(raw), expected);
}

for (const safeId of [
	"task-123",
	"disk-1",
	"Task-99",
	"npm_package_name",
	"key=ok",
	"https://github.com/org/task-123/pull/42",
]) {
	assert.equal(redact(safeId), safeId);
}

// Producer enforces server schema caps (1000 runs, 100 attempts, 2000 turns, 100 links, 1024 metadata) and 4 MiB byte cap.
const cappedLedger = [];
const cappedFiles = new Map();

for (let i = 0; i < 1005; i++) {
	const runId = `run-${i}`;
	const stamp = new Date(now - i * 1000).toISOString();

	cappedLedger.push(
		JSON.stringify({
			event: "launch",
			runId,
			at: stamp,
			dataClass: "sensitive",
			model: i === 0 ? "model word ".repeat(150) : "model",
		}),
	);

	if (i === 0) {
		for (let attempt = 1; attempt <= 105; attempt++) {
			cappedLedger.push(
				JSON.stringify({
					event: "attempt",
					runId,
					at: stamp,
					attempt,
					model: attempt === 105 ? "model word ".repeat(150) : `m-${attempt}`,
				}),
				JSON.stringify({
					event: "outcome",
					runId,
					at: stamp,
					attempt,
					exitCode: attempt === 105 ? 0 : 1,
					failureClass: "failure reason ".repeat(120),
				}),
			);
		}
	} else {
		cappedLedger.push(JSON.stringify({ event: "outcome", runId, at: stamp, exitCode: 0 }));
	}
}

const longTurns = Array.from({ length: 2050 }, (_, index) =>
	JSON.stringify({
		type: "item.completed",
		item: {
			id: `turn-${index}`,
			type: "tool_call",
			tool: "tool name ".repeat(150),
			input: `echo ${index}`,
			output: "x ".repeat(1500),
			exit_code: 0,
		},
	}),
);

cappedFiles.set("/capped/ledger.jsonl", cappedLedger.join("\n"));
cappedFiles.set("/capped/runs/run-0.events.jsonl", longTurns.join("\n"));

const manyLinks = [
	...Array.from({ length: 110 }, (_, index) => `https://github.com/org/task-123/pull/${index + 1}`),
	"https://gitlab.com/group/project/-/merge_requests/7",
	"https://gitlab.com/group/sub/project/-/merge_requests/9",
].join(" ");

cappedFiles.set("/capped/runs/run-0.out", manyLinks);

const cappedResult = await snapshot({
	stateDir: "/capped",
	now,
	read: async (filePath) => {
		if (cappedFiles.has(filePath)) {
			return cappedFiles.get(filePath);
		}

		throw Object.assign(new Error("missing"), { code: "ENOENT" });
	},
});

assert.equal(cappedResult.runs.length, 1000);
assert.equal(cappedResult.runs[0].id, "run-0");
assert.equal(cappedResult.runs[0].model.length, 1024);
assert.equal(cappedResult.runs[0].attempts.length, 100);
assert.equal(cappedResult.runs[0].attempts[0].number, 6);
assert.equal(cappedResult.runs[0].attempts[0].failureClass.length, 1024);
assert.ok(cappedResult.runs[0].turns.length > 0 && cappedResult.runs[0].turns.length < 2000);
assert.equal(cappedResult.runs[0].turns.at(-1).text, "echo 2049");
assert.ok(cappedResult.runs[0].turns.every((turn) => turn.name.length === 1024));
assert.equal(cappedResult.runs[0].links.length, 100);
assert.equal(cappedResult.runs[0].links[0], "https://github.com/org/task-123/pull/1");

assert.equal(
	cappedResult.runs[0].links.includes("https://gitlab.com/group/sub/project/-/merge_requests/9"),
	false,
);

assert.ok(
	Buffer.byteLength(JSON.stringify(cappedResult), "utf8") <= 4 * 1024 * 1024,
	"snapshot payload exceeds 4 MiB",
);

const gitlabLinks = await snapshot({
	stateDir: "/gl",
	now,
	read: async (filePath) => {
		if (filePath === "/gl/ledger.jsonl") {
			return [
				JSON.stringify({ event: "launch", runId: "gl-1", at, dataClass: "public" }),
				JSON.stringify({ event: "outcome", runId: "gl-1", at, exitCode: 0 }),
				JSON.stringify({ event: "launch", runId: "gl-2", at, dataClass: "public" }),
				JSON.stringify({ event: "attempt", runId: "gl-2", at, dataClass: "parcs" }),
				JSON.stringify({ event: "outcome", runId: "gl-2", at, exitCode: 0 }),
			].join("\n");
		}

		if (filePath === "/gl/runs/gl-1.out") {
			return "MR https://gitlab.com/group/project/-/merge_requests/7 and https://gitlab.com/group/sub/project/-/merge_requests/9";
		}

		if (filePath === "/gl/runs/gl-2.out") {
			throw new Error("must not open conflicted parcs run");
		}

		throw Object.assign(new Error("missing"), { code: "ENOENT" });
	},
});

assert.deepEqual(gitlabLinks.runs.find((run) => run.id === "gl-1").links, [
	"https://gitlab.com/group/project/-/merge_requests/7",
]);

assert.equal(gitlabLinks.runs.find((run) => run.id === "gl-2").dataClass, "unknown");

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
