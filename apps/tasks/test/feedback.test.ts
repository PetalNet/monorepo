import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";

import { ConfigProvider, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const tmp = mkdtempSync(path.join(tmpdir(), "feedback-test-"));

process.env.TASKS_DB_PATH = path.join(tmp, "tasks.db");

const db = await import("#lib/server/db.js");
const { JANET_SHIM } = await import("#lib/janet-shim.js");
const { Feedback, FeedbackLive, Viewer } = await import("#lib/server/gallery/feedback.ts");
const { MatrixNotConfigured, MatrixPoster, MatrixPosterLive } =
	await import("#lib/server/gallery/matrix.ts");

afterAll(() => {
	db.default.close();
	rmSync(tmp, { recursive: true, force: true });
});

/** A poster that records what it was asked to send. Event ids are `$test1`, `$test2`, ... */
const MatrixPosterTest = (sent: string[]) =>
	Layer.succeed(MatrixPoster, {
		post: (text) =>
			Effect.sync(() => {
				sent.push(text);

				return `$test${sent.length}`;
			}),
	});

let sent: string[] = [];

const run = <A, E>(
	user: string,
	use: (feedback: typeof Feedback.Service) => Effect.Effect<A, E, typeof Viewer.Identifier>,
	matrix: Layer.Layer<typeof MatrixPoster.Identifier> = MatrixPosterTest(sent),
) =>
	Effect.runPromise(
		Effect.flatMap(Feedback, use).pipe(
			Effect.provide(FeedbackLive.pipe(Layer.provide(matrix))),
			Effect.provideService(Viewer, { user }),
		),
	);

const publish = (slug: string, extra: Record<string, unknown> = {}) =>
	db.upsertArtifact({
		slug,
		title: `Page ${slug}`,
		kind: "interactive",
		content: "<p>pick one</p>",
		owner: "parker",
		collection: "demo",
		caps: ["feedback"],
		audience: ["parker"],
		...extra,
	});

beforeEach(() => {
	sent = [];
});

describe("send", () => {
	it("stores the answer under the viewer and the current rev, then posts it to Matrix", async () => {
		publish("pick");

		const result = await run("parker", (f) =>
			f.send({ slug: "pick", anchor: { q: "color" }, payload: { choice: "blue" } }),
		);

		expect(result).toEqual({ id: expect.any(Number), rev: 1, matrixEventId: "$test1" });
		expect(sent).toHaveLength(1);

		expect(sent[0]).toMatch(
			/^\[gallery\] parker answered "Page pick" \(rev 1, feedback #\d+\): \{"choice":"blue"\}/,
		);

		const row = db.getFeedback(result.id);

		expect(row).toMatchObject({
			slug: "pick",
			author: "parker",
			status: "sent",
			matrix_event_id: "$test1",
			payload: { choice: "blue" },
		});
	});

	it("refuses a viewer the page does not ask, and says nothing to Matrix", async () => {
		publish("only-parker");

		await expect(
			run("elisha", (f) => f.send({ slug: "only-parker", anchor: {}, payload: 1 })),
		).rejects.toMatchObject({ _tag: "NotAskedHere" });

		expect(sent).toHaveLength(0);
		expect(db.listFeedback("only-parker")).toHaveLength(0);
	});

	it("refuses a page without the feedback capability even for its audience", async () => {
		publish("no-cap", { caps: [] });

		await expect(
			run("parker", (f) => f.send({ slug: "no-cap", anchor: {}, payload: 1 })),
		).rejects.toMatchObject({ _tag: "NotAskedHere" });
	});

	it("answers 404 for a private page the viewer cannot see, the same as for a missing one", async () => {
		publish("secret", { visibility: "private", audience: ["elisha"] });

		await Promise.all(
			["secret", "missing"].map((slug) =>
				expect(
					run("elisha", (f) => f.send({ slug, anchor: {}, payload: 1 })),
				).rejects.toMatchObject({
					_tag: "ArtifactNotFound",
				}),
			),
		);
	});

	it("keeps the answer when Matrix is down, with no event id", async () => {
		publish("matrix-down");

		const down = Layer.succeed(MatrixPoster, {
			post: () => Effect.fail(new MatrixNotConfigured()),
		});
		const result = await run(
			"parker",
			(f) => f.send({ slug: "matrix-down", anchor: {}, payload: "x" }),
			down,
		);

		expect(result.matrixEventId).toBeNull();
		expect(db.getFeedback(result.id)).toMatchObject({ status: "sent", matrix_event_id: null });
	});

	it("rejects an oversized payload before storing it", async () => {
		publish("big");

		await expect(
			run("parker", (f) => f.send({ slug: "big", anchor: {}, payload: "x".repeat(9_000) })),
		).rejects.toMatchObject({ _tag: "PayloadTooLarge" });

		expect(db.listFeedback("big")).toHaveLength(0);
	});
});

describe("needs you", () => {
	it("lists a page only for the viewers it asks, until they answer at the current rev", async () => {
		publish("asks-both", { audience: ["parker", "elisha"] });
		publish("asks-eli", { audience: ["elisha"] });

		const slugs = async (user: string) =>
			(await run(user, (f) => f.needsYou))
				.map((item) => item.slug)
				.filter((s) => s.startsWith("asks-"));

		expect(await slugs("parker")).toEqual(["asks-both"]);
		expect((await slugs("elisha")).toSorted()).toEqual(["asks-both", "asks-eli"]);

		await run("parker", (f) => f.send({ slug: "asks-both", anchor: {}, payload: 1 }));
		expect(await slugs("parker")).toEqual([]);
		expect(await slugs("elisha")).toContain("asks-both");

		// a new revision asks again
		publish("asks-both", { audience: undefined });
		expect(await slugs("parker")).toEqual(["asks-both"]);
	});
});

describe("revise and resolve", () => {
	it("bumps rev on republish, keeps caps and audience when omitted, and resolves at the new rev", async () => {
		const first = publish("revise");
		const second = db.upsertArtifact({
			slug: "revise",
			title: "Page revise",
			kind: "interactive",
			content: "<p>v2</p>",
			owner: "parker",
			collection: "demo",
		});

		expect([first.rev, second.rev]).toEqual([1, 2]);
		expect([second.caps, second.audience]).toEqual(['["feedback"]', '["parker"]']);

		const answer = await run("parker", (f) => f.send({ slug: "revise", anchor: {}, payload: "a" }));

		db.upsertArtifact({
			slug: "revise",
			title: "Page revise",
			kind: "interactive",
			content: "<p>v3</p>",
		});

		const resolved = db.resolveFeedback({ id: answer.id, resolution: "went with a" });

		expect(resolved).toMatchObject({
			status: "resolved",
			resolution: "went with a",
			resolved_rev: 3,
		});

		const state = await run("parker", (f) => f.state("revise"));

		expect(state.rev).toBe(3);
		expect(state.feedback.map((x: { status: string }) => x.status)).toEqual(["resolved"]);
	});

	it("keeps visibility, owner, description and source when a republish omits them", () => {
		db.upsertArtifact({
			slug: "stays-private",
			title: "Private page",
			content: "<p>v1</p>",
			description: "blurb",
			source: "notes.md",
			owner: "parker",
			visibility: "private",
		});

		const revised = db.upsertArtifact({
			slug: "stays-private",
			title: "Private page",
			content: "<p>v2</p>",
		});

		expect(revised).toMatchObject({
			rev: 2,
			visibility: "private",
			owner: "parker",
			description: "blurb",
			source: "notes.md",
			content: "<p>v2</p>",
		});

		expect(db.getArtifact("stays-private", "elisha")).toBeUndefined();
	});

	it("shows a viewer only their own answers", async () => {
		publish("mine", { audience: ["parker", "elisha"] });
		await run("parker", (f) => f.send({ slug: "mine", anchor: {}, payload: "p" }));
		await run("elisha", (f) => f.send({ slug: "mine", anchor: {}, payload: "e" }));

		expect((await run("elisha", (f) => f.state("mine"))).feedback).toHaveLength(1);
	});
});

describe("project separation", () => {
	it("scopes an answer to its own page: another page in another project sees none of it", async () => {
		publish("proj-a", { collection: "alpha" });
		publish("proj-b", { collection: "beta" });
		await run("parker", (f) => f.send({ slug: "proj-a", anchor: {}, payload: "for a" }));

		expect(db.listFeedback("proj-a")).toHaveLength(1);
		expect(db.listFeedback("proj-b")).toHaveLength(0);
		expect((await run("parker", (f) => f.state("proj-b"))).feedback).toHaveLength(0);
	});
});

describe("matrix poster", () => {
	it("PUTs an m.room.message with the bot token and returns the event id", async () => {
		const seen: { method?: string; url?: string; auth?: string; body?: string }[] = [];
		const server = createServer((request, response) => {
			let body = "";

			request.on("data", (chunk) => (body += chunk));

			request.on("end", () => {
				seen.push({
					method: request.method,
					url: request.url,
					auth: request.headers.authorization,
					body,
				});

				response.setHeader("content-type", "application/json");
				response.end(JSON.stringify({ event_id: "$fake:test" }));
			});
		});

		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", resolve);
		});

		const tokenFile = path.join(tmp, "token");

		writeFileSync(tokenFile, "bot-token\n");

		const settings = ConfigProvider.layer(
			ConfigProvider.fromEnv({
				env: {
					MATRIX_HOMESERVER: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
					MATRIX_ROOM: "!room:test",
					MATRIX_TOKEN_FILE: tokenFile,
				},
			}),
		);

		try {
			const id = await Effect.runPromise(
				Effect.flatMap(MatrixPoster, (poster) => poster.post("[gallery] hi")).pipe(
					Effect.provide(
						MatrixPosterLive.pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(settings)),
					),
				),
			);

			expect(id).toBe("$fake:test");
			expect(seen).toHaveLength(1);
			expect(seen[0]).toMatchObject({ method: "PUT", auth: "Bearer bot-token" });

			expect(seen[0].url).toMatch(
				/^\/_matrix\/client\/v3\/rooms\/!room%3Atest\/send\/m\.room\.message\/[0-9a-f-]+$/,
			);

			expect(JSON.parse(seen[0].body!)).toEqual({ msgtype: "m.text", body: "[gallery] hi" });
		} finally {
			server.close();
		}
	});

	it("fails with MatrixNotConfigured when the settings are absent", async () => {
		await expect(
			Effect.runPromise(
				Effect.flatMap(MatrixPoster, (poster) => poster.post("x")).pipe(
					Effect.provide(
						MatrixPosterLive.pipe(
							Layer.provide(FetchHttpClient.layer),
							Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
						),
					),
				),
			),
		).rejects.toMatchObject({ _tag: "MatrixNotConfigured" });
	});
});

describe("janet shim", () => {
	it("round-trips a call through the parent and delivers events", async () => {
		const posted: unknown[] = [];
		const listeners: ((e: { source: unknown; data: unknown }) => void)[] = [];
		const parent = { postMessage: (m: unknown) => posted.push(m) };
		const sandbox: Record<string, unknown> = {
			parent,
			addEventListener: (_: string, f: (typeof listeners)[number]) => listeners.push(f),
			Promise,
			Error,
		};

		sandbox.window = sandbox;
		vm.runInNewContext(JANET_SHIM, sandbox);

		const janet = sandbox.janet as {
			send: (a: unknown) => Promise<unknown>;
			on: (n: string, f: (d: unknown) => void) => void;
		};
		const promise = janet.send({ payload: "x" });

		expect(posted[0]).toMatchObject({ janet: "send", id: 1, args: { payload: "x" } });
		listeners[0]({ source: {}, data: { janet: "reply", id: 1, ok: true, result: "forged" } });
		listeners[0]({ source: parent, data: { janet: "reply", id: 1, ok: true, result: { id: 7 } } });
		await expect(promise).resolves.toEqual({ id: 7 });

		const seen: unknown[] = [];

		janet.on("resolved", (d) => seen.push(d));

		listeners[0]({
			source: parent,
			data: { janet: "event", name: "resolved", detail: { id: 7 } },
		});

		expect(seen).toEqual([{ id: 7 }]);
	});
});
