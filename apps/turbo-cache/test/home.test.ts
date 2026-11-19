import { generateKeyPairSync } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Redacted } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpServer from "effect/http/HttpServer";
import { afterEach, describe, expect, it } from "vitest";

import { createExchanger } from "../src/exchanger.ts";
import { renderHome } from "../src/home.ts";
import { application } from "../src/server.ts";
import { createEventCounter, parseEvents } from "../src/stats.ts";

const hour = 3_600_000;

describe("event counting", () => {
	it("counts only remote hits and misses", () => {
		const body = JSON.stringify([
			{ source: "REMOTE", event: "HIT", hash: "a" },
			{ source: "REMOTE", event: "HIT", hash: "b" },
			{ source: "REMOTE", event: "MISS", hash: "c" },
			{ source: "LOCAL", event: "HIT", hash: "d" },
			{ source: "REMOTE", event: "OTHER" },
			"junk",
		]);

		expect(parseEvents(body)).toEqual({ hit: 2, miss: 1 });
		expect(parseEvents("not json")).toEqual({ hit: 0, miss: 0 });
		expect(parseEvents("{}")).toEqual({ hit: 0, miss: 0 });
	});

	it("keeps a rolling 24 hour window and forgets older hours", () => {
		let now = 1_000 * hour;
		const counter = createEventCounter(() => now);

		counter.record({ hit: 3, miss: 1 });
		now += 5 * hour;
		counter.record({ hit: 1, miss: 0 });

		const during = counter.snapshot();

		expect(during.hours).toHaveLength(24);
		expect([during.hit, during.miss]).toEqual([4, 1]);
		expect(during.hours.at(-1)?.hit).toBe(1);

		now += 20 * hour;

		const later = counter.snapshot();

		expect([later.hit, later.miss]).toEqual([1, 0]);
	});

	it("restores from its saved form", () => {
		const now = 1_000 * hour;
		const first = createEventCounter(() => now);

		first.record({ hit: 2, miss: 2 });

		const saved = first.pending();

		expect(saved).not.toBeNull();
		expect(first.pending()).not.toBeNull();
		first.markSaved();
		expect(first.pending()).toBeNull();
		expect(createEventCounter(() => now, saved ?? undefined).snapshot().hit).toBe(2);
	});
});

describe("home page", () => {
	const data = {
		now: 1_000 * hour,
		cacheUp: true,
		storage: {
			updated: 1_000 * 3600 - 120,
			files: 1234,
			bytes: 5 * 1024 ** 3,
			max_bytes: 40 * 1024 ** 3,
			evicted_files: 0,
			evicted_bytes: 0,
			last_eviction: null,
		},
		events: createEventCounter(() => 1_000 * hour).snapshot(),
		build: "abcdef0123456789",
	};

	it("renders live numbers, the policy and the connection steps", () => {
		const html = renderHome(data);

		expect(html).toContain("1,234");
		expect(html).toContain("5.00 GiB");
		expect(html).toContain("Nothing has been evicted yet.");
		expect(html).toContain("No remote lookups reported yet.");
		expect(html).toContain("GitHub main push");
		expect(html).toContain("TURBO_API=https://turbo-cache.petalcat.dev");
		expect(html).toContain("abcdef0");
		expect(html).not.toContain("abcdef0123");
	});

	it("shows an empty state before the first eviction pass", () => {
		expect(renderHome({ ...data, storage: null })).toContain("Waiting for the first eviction pass");
	});
});

describe("server", () => {
	const servers: Server[] = [];

	afterEach(async () => {
		await Promise.all(
			servers.splice(0).map(
				(server) =>
					new Promise<void>((resolve) => {
						server.close(() => {
							resolve();
						});

						server.closeAllConnections();
					}),
			),
		);
	});

	async function listen(server: Server) {
		servers.push(server);

		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", resolve);
		});

		return (server.address() as AddressInfo).port;
	}

	async function start() {
		const received: { method: string; url: string; authorization?: string; body: string }[] = [];
		const cache = createServer((request: IncomingMessage, response) => {
			let body = "";

			request.on("data", (chunk: Buffer) => {
				body += chunk.toString();
			});

			request.on("end", () => {
				received.push({
					method: request.method ?? "",
					url: request.url ?? "",
					...(request.headers.authorization === undefined
						? {}
						: { authorization: request.headers.authorization }),
					body,
				});

				if (request.url?.startsWith("/v8/artifacts/events")) {
					const ok = request.headers.authorization === "Bearer good";

					response.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
					response.end(ok ? "" : '{"error":"Unauthorized"}');
				} else {
					response.writeHead(200);
					response.end();
				}
			});
		});
		const cachePort = await listen(cache);
		const events = createEventCounter();
		const exchanger = await Effect.runPromise(
			createExchanger({
				audience: "turbo-cache.petalcat.dev",
				issuer: "https://turbo-cache.petalcat.dev",
				team: "petalnet",
				privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey,
				authentikIssuer: "https://auth.petalcat.dev/application/o/turbo-cache/",
				ampWorkspaceIds: [],
				ampProjectIds: [],
				githubToken: Redacted.make(""),
				providers: new Map(),
			}).pipe(Effect.provide(FetchHttpClient.layer)),
		);
		const site = {
			build: "test",
			cacheUrl: `http://127.0.0.1:${String(cachePort)}`,
			storageFile: "/nonexistent/storage.json",
			events,
			fonts: { geist: new Uint8Array([1, 2, 3]) },
		};
		const web = createServer();
		const port = await listen(web);

		servers.pop();
		web.close();

		await new Promise<void>((resolve) => {
			web.once("close", resolve);
		});

		const served = createServer();
		const layer = HttpServer.serve(application(exchanger, site)).pipe(
			Layer.provide(NodeHttpServer.layer(() => served, { port })),
		);
		const fiber = Effect.runFork(Layer.launch(layer));

		servers.push(served);

		await new Promise<void>((resolve) => {
			setTimeout(resolve, 200);
		});

		return {
			base: `http://127.0.0.1:${String(port)}`,
			events,
			received,
			stop: () => {
				fiber.interruptUnsafe();
			},
		};
	}

	it("serves the page and leaves the API paths alone", async () => {
		const { base, events, received, stop } = await start();

		try {
			const home = await fetch(`${base}/`);
			const html = await home.text();

			expect(home.status).toBe(200);
			expect(home.headers.get("content-type")).toContain("text/html");
			expect(home.headers.get("content-security-policy")).toContain("script-src 'sha256-");
			expect(html).toContain("PetalNet Turbo cache");
			expect(html).toContain("Cache server answering");
			expect((await fetch(`${base}/_live`)).status).toBe(200);

			expect(
				((await (await fetch(`${base}/stats.json`)).json()) as { cache_up: boolean }).cache_up,
			).toBe(true);

			expect((await fetch(`${base}/assets/geist.woff2`)).headers.get("content-type")).toBe(
				"font/woff2",
			);

			expect((await fetch(`${base}/assets/constructor.woff2`)).status).toBe(404);
			expect((await fetch(`${base}/.well-known/jwks.json`)).status).toBe(200);
			expect((await fetch(`${base}/exchange`, { method: "POST" })).status).toBe(401);
			expect((await fetch(`${base}/nope`)).status).toBe(404);
			expect((await fetch(`${base}/`, { method: "POST" })).status).toBe(404);

			const body = JSON.stringify([
				{ source: "REMOTE", event: "HIT", hash: "a" },
				{ source: "REMOTE", event: "MISS", hash: "b" },
			]);
			const url = `${base}/v8/artifacts/events?slug=petalnet`;
			const anonymous = await fetch(url, {
				method: "POST",
				body,
				headers: { "content-type": "application/json" },
			});

			expect(anonymous.status).toBe(401);
			expect(await anonymous.text()).toBe('{"error":"Unauthorized"}');
			expect(events.snapshot().hit).toBe(0);

			const authorized = await fetch(url, {
				method: "POST",
				body,
				headers: { "content-type": "application/json", authorization: "Bearer good" },
			});

			expect(authorized.status).toBe(200);

			// The server may answer 4xx or drop the connection; it must not forward the body.
			await fetch(url, {
				method: "POST",
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array(2_000_000));
						controller.close();
					},
				}),
				headers: { authorization: "Bearer good" },
				duplex: "half",
			} as RequestInit).catch(() => undefined);

			expect(received.filter((item) => item.body.length > 1_048_576)).toEqual([]);
			expect([events.snapshot().hit, events.snapshot().miss]).toEqual([1, 1]);

			const forwarded = received.filter((item) => item.url.startsWith("/v8/artifacts/events"));

			expect(forwarded.map((item) => [item.url, item.body])).toEqual([
				["/v8/artifacts/events?slug=petalnet", body],
				["/v8/artifacts/events?slug=petalnet", body],
			]);

			expect(html).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}|PRIVATE KEY|github_pat_|ghp_/);
		} finally {
			stop();
		}
	});
});
