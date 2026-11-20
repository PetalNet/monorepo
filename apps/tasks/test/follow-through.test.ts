import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RequestEvent } from "@sveltejs/kit";
import { afterAll, describe, expect, it, vi } from "vitest";

const directory = mkdtempSync(path.join(tmpdir(), "follow-through-api-"));
const calls = path.join(directory, "calls.jsonl");
const command = path.join(directory, "control.mjs");

writeFileSync(calls, "");

writeFileSync(
	command,
	`import { appendFileSync } from 'node:fs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
appendFileSync(process.argv[2], input + '\\n');
const command = JSON.parse(input);
if (command.id === 99) process.stdout.write('invalid');
else if (command.id === 98) process.stdout.write('x'.repeat(1024 * 1024 + 1));
else process.stdout.write(JSON.stringify({paused: true, scheduler: 'paused', lastSweep: null, items: []}));`,
);

vi.stubEnv("FOLLOW_THROUGH_OPERATORS", "tester");
vi.stubEnv("FOLLOW_THROUGH_COMMAND_ARGV", JSON.stringify([process.execPath, command, calls]));

const { followThroughApi } = await import("#lib/server/follow-through/api.ts");

afterAll(async () => {
	await followThroughApi.dispose();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

function unused(): never {
	throw new Error("Unexpected SvelteKit request capability");
}

function request(urlPath: string, body?: unknown, user = "tester", origin?: string) {
	const url = new URL(`/api/follow-through${urlPath}`, "https://tasks.test");
	const headers = new Headers({ "content-type": "application/json" });

	if (origin) {
		headers.set("origin", origin);
	}

	const event: RequestEvent = {
		request: new Request(url, {
			method: body === undefined ? "GET" : "POST",
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		url,
		locals: { user },
		params: {},
		platform: undefined,
		route: { id: null },
		isDataRequest: false,
		isSubRequest: false,
		isRemoteRequest: false,
		fetch: unused,
		getClientAddress: unused,
		setHeaders: unused,
		get cookies() {
			return unused();
		},
		get tracing() {
			return unused();
		},
	};

	return followThroughApi.http(event);
}

describe("follow-through HTTP boundary", () => {
	it("denies unauthorized reads and foreign or missing origins before starting the command", async () => {
		const before = readFileSync(calls, "utf8");

		expect((await request("/promises", undefined, "outsider")).status).toBe(403);

		const responses = await Promise.all(
			[undefined, "https://unrelated.test"].map((origin) =>
				request("/delivery", { paused: true }, "tester", origin),
			),
		);

		expect(responses.map((response) => response.status)).toEqual([403, 403]);

		expect(readFileSync(calls, "utf8")).toBe(before);
	});

	it("rejects blank reasons as input errors without starting the command", async () => {
		const before = readFileSync(calls, "utf8");

		const responses = await Promise.all(
			["", "   ", "\t\n"].map((reason) =>
				request("/promises/1/drop", { reason }, "tester", "https://tasks.test"),
			),
		);

		expect(responses.map((response) => response.status)).toEqual([400, 400, 400]);

		expect(readFileSync(calls, "utf8")).toBe(before);
	});

	it("runs an authorized command with structured input and validates its response", async () => {
		const response = await request(
			"/promises/1/drop",
			{ reason: "No longer needed." },
			"tester",
			"https://tasks.test",
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ paused: true, scheduler: "paused" });

		expect(JSON.parse(readFileSync(calls, "utf8").trim().split("\n").at(-1) ?? "")).toEqual({
			action: "drop",
			id: 1,
			reason: "No longer needed.",
		});
	});

	it("withholds malformed and oversized command output", async () => {
		const responses = await Promise.all(
			[99, 98].map((id) =>
				request(`/promises/${id}/snooze`, { hours: 24 }, "tester", "https://tasks.test"),
			),
		);

		expect(responses.map((response) => response.status)).toEqual([503, 503]);
	});
});
