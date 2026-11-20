import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RequestEvent } from "@sveltejs/kit";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(path.join(tmpdir(), "agents-snapshot-"));

process.env.TASKS_DB_PATH = path.join(dir, "tasks.db");
process.env.TASKS_AGENTS_INGEST_TOKEN = "dedicated-synthetic-token";
const { ingestRequest, agentsApi } = await import("#lib/server/agents/api.ts");
const { load } = await import("../src/routes/janet/agents/+page.server.js");
const { default: db } = await import("#lib/server/db.js");

afterAll(async () => {
	await agentsApi.dispose();
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

const run = (dataClass?: string) => ({
	id: "run-1",
	name: "sample",
	status: "done",
	model: "model",
	effort: "low",
	plan: "plan",
	pool: "pool",
	kind: "code",
	tier: "B",
	...(dataClass === undefined ? {} : { dataClass }),
	startedAt: 1,
	endedAt: 2,
	attempts: [],
	turns: [
		{
			id: "1",
			kind: "assistant",
			name: "test",
			text: "synthetic private turn",
			result: "synthetic result",
			resultBytes: null,
			status: "done",
			at: 2,
		},
	],
	output: "synthetic private output",
	links: ["https://github.com/example/repo/pull/1"],
});
const snapshot = (updatedAt: string, runs = [run("sensitive")]) => ({ updatedAt, runs });
const send = (
	body: string | ReadableStream<Uint8Array>,
	token = "dedicated-synthetic-token",
	method = "POST",
) => {
	const url = new URL("http://localhost/api/agent/agents/snapshot");
	const init: RequestInit & { duplex?: "half" } = {
		method,
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		...(method === "POST" ? { body, ...(typeof body === "string" ? {} : { duplex: "half" }) } : {}),
	};
	const request = new Request(url, init);

	return ingestRequest({ request, url, locals: {} } as RequestEvent);
};

describe("agents snapshot ingest", () => {
	it("starts empty and refuses missing or incorrect credentials, other methods and oversized bodies", async () => {
		expect(load().snapshot).toBeNull();
		const body = JSON.stringify(snapshot("2026-11-19T00:00:00.000Z"));

		expect((await send(body, "wrong")).status).toBe(401);
		delete process.env.TASKS_AGENTS_INGEST_TOKEN;
		expect((await send(body)).status).toBe(401);
		process.env.TASKS_AGENTS_INGEST_TOKEN = "dedicated-synthetic-token";
		expect((await send(body, "dedicated-synthetic-token", "GET")).status).toBe(405);
		expect((await send(" ".repeat(4 * 1024 * 1024 + 1))).status).toBe(413);

		const chunked = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(2 * 1024 * 1024));
				controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
				controller.close();
			},
		});

		expect((await send(chunked)).status).toBe(413);
		expect(load().snapshot).toBeNull();
	});

	it("stores validated content only for public and sensitive runs and rejects old or invalid snapshots", async () => {
		const body = snapshot("2026-11-19T00:00:00.000Z", [
			run("sensitive"),
			run("public"),
			run("parcs"),
			run(),
			run("unexpected"),
		]);

		expect((await send(JSON.stringify(body))).status).toBe(200);
		const saved = load().snapshot;

		expect(saved?.runs[0]?.output).toBe("synthetic private output");
		expect(saved?.runs[1]?.turns[0]?.text).toBe("synthetic private turn");

		for (const item of saved?.runs.slice(2) ?? []) {
			expect(item).toMatchObject({ turns: [], output: "", links: [] });
		}

		expect(saved?.runs.map((item) => item.dataClass)).toEqual([
			"sensitive",
			"public",
			"parcs",
			"unknown",
			"unknown",
		]);

		expect((await send(JSON.stringify(snapshot("2026-11-18T00:00:00.000Z")))).status).toBe(409);
		expect((await send(JSON.stringify(snapshot("2026-11-19T00:00:00.000Z")))).status).toBe(409);
		expect((await send(JSON.stringify({ updatedAt: "invalid", runs: [] }))).status).toBe(400);

		expect(
			(
				await send(
					JSON.stringify({
						updatedAt: "2026-11-20T00:00:00.000Z",
						runs: [{ ...run("public"), attempts: Array.from({ length: 101 }, () => ({})) }],
					}),
				)
			).status,
		).toBe(400);

		expect(load().snapshot).toEqual(saved);
	});
});
