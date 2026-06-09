import { type AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
	createSearchServer,
	handleSearch,
	providersFromEnv,
	type SearchHttpResponse,
} from "./server.ts";
import type { Provider, QueryOptions, QueryResponse, Result } from "./types.ts";

/** A network-free provider returning canned results, mirroring federate.test.ts. */
function fakeProvider(
	id: string,
	results: readonly Partial<Result>[],
	opts: { weight?: number; throws?: boolean; actions?: boolean } = {},
): Provider {
	return {
		id,
		name: id,
		...(opts.weight !== undefined ? { weight: opts.weight } : {}),
		query(_q: string, _o: QueryOptions): Promise<QueryResponse> {
			if (opts.throws) return Promise.reject(new Error(`${id} boom`));
			return Promise.resolve({
				results: results.map((r, i) => ({
					id: r.id ?? `${id}-${i}`,
					providerId: id,
					title: r.title ?? `${id} ${i}`,
					score: r.score ?? 0.5,
					kind: r.kind ?? "web",
					...(r.url !== undefined ? { url: r.url } : {}),
				})),
				...(opts.actions
					? {
							actions: [
								{
									id: `${id}:act`,
									providerId: id,
									title: "do a thing",
									// A live invoke fn must NOT survive serialization.
									invoke: () => undefined,
									raw: { intent: "thing" },
								},
							],
						}
					: {}),
			});
		},
	};
}

/** Start the server on an ephemeral port and return a base URL + closer. */
async function listen(
	providers: readonly Provider[],
): Promise<{ base: string; close: () => Promise<void> }> {
	const server = createSearchServer({ providers });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address() as AddressInfo;
	return {
		base: `http://127.0.0.1:${addr.port}`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	await Promise.all(closers.splice(0).map((c) => c()));
});

describe("handleSearch (transport-agnostic core)", () => {
	it("returns the wire-shaped federated response", async () => {
		const body = await handleSearch("hi", undefined, {
			providers: [fakeProvider("a", [{ score: 0.9 }]), fakeProvider("b", [{ score: 0.5 }])],
		});
		expect(body.query).toBe("hi");
		expect(body.providers).toEqual(["a", "b"]);
		expect(body.results).toHaveLength(2);
		expect(body.errors).toHaveLength(0);
	});

	it("strips the non-serializable invoke fn from actions", async () => {
		const body = await handleSearch("hi", undefined, {
			providers: [fakeProvider("a", [{ score: 0.5 }], { actions: true })],
		});
		expect(body.actions).toHaveLength(1);
		expect("invoke" in body.actions[0]!).toBe(false);
		// Whole body must round-trip through JSON (no functions, no cycles).
		expect(() => JSON.stringify(body)).not.toThrow();
	});

	it("flattens provider errors to a string message", async () => {
		const body = await handleSearch("hi", undefined, {
			providers: [fakeProvider("ok", [{ score: 0.5 }]), fakeProvider("bad", [], { throws: true })],
		});
		expect(body.providers).toEqual(["ok"]);
		expect(body.errors).toEqual([{ providerId: "bad", reason: "error", message: "bad boom" }]);
	});

	it("forwards a limit to federation", async () => {
		const body = await handleSearch("hi", 1, {
			providers: [fakeProvider("a", [{ score: 0.9 }, { score: 0.8 }])],
		});
		expect(body.results).toHaveLength(1);
	});
});

describe("GET /search (http)", () => {
	it("serves ranked JSON over HTTP", async () => {
		const { base, close } = await listen([
			fakeProvider("a", [{ score: 0.9, url: "https://a.com" }]),
			fakeProvider("b", [{ score: 0.5, url: "https://b.com" }]),
		]);
		closers.push(close);
		const res = await fetch(`${base}/search?q=hello`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		const body = (await res.json()) as SearchHttpResponse;
		expect(body.query).toBe("hello");
		expect(body.results.map((r) => r.providerId)).toEqual(["a", "b"]);
	});

	it("honors a valid limit param", async () => {
		const { base, close } = await listen([
			fakeProvider("a", [{ score: 0.9 }, { score: 0.8 }, { score: 0.7 }]),
		]);
		closers.push(close);
		const res = await fetch(`${base}/search?q=hi&limit=2`);
		const body = (await res.json()) as SearchHttpResponse;
		expect(body.results).toHaveLength(2);
	});

	it("400s on a non-positive-integer limit", async () => {
		const { base, close } = await listen([fakeProvider("a", [{ score: 0.5 }])]);
		closers.push(close);
		const res = await fetch(`${base}/search?q=hi&limit=-3`);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("bad_limit");
	});

	it("treats a missing q as an empty (no-provider) search", async () => {
		let called = false;
		const spy: Provider = {
			id: "spy",
			name: "spy",
			query() {
				called = true;
				return Promise.resolve({ results: [] });
			},
		};
		const { base, close } = await listen([spy]);
		closers.push(close);
		const res = await fetch(`${base}/search`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as SearchHttpResponse;
		expect(body.results).toHaveLength(0);
		expect(called).toBe(false);
	});

	it("404s an unknown path and 405s a non-GET", async () => {
		const { base, close } = await listen([fakeProvider("a", [])]);
		closers.push(close);
		expect((await fetch(`${base}/nope`)).status).toBe(404);
		expect((await fetch(`${base}/search?q=x`, { method: "POST" })).status).toBe(405);
	});

	it("serves /health with the registered provider ids", async () => {
		const { base, close } = await listen([fakeProvider("a", []), fakeProvider("b", [])]);
		closers.push(close);
		const res = await fetch(`${base}/health`);
		const body = (await res.json()) as { ok: boolean; providers: string[] };
		expect(body.ok).toBe(true);
		expect(body.providers).toEqual(["a", "b"]);
	});
});

describe("providersFromEnv", () => {
	it("registers a single web provider by default", () => {
		const reg = providersFromEnv({});
		expect(reg.list().map((p) => p.id)).toEqual(["web"]);
	});

	it("still registers exactly the web provider when config is supplied", () => {
		// Config tunes the web provider (baseUrl/engines/etc.) but doesn't add
		// providers — notes/calendar aren't built yet.
		const reg = providersFromEnv({
			SEARXNG_URL: "https://searx.example",
			SEARXNG_ENGINES: "duckduckgo, brave",
			SEARXNG_CATEGORIES: "general,news",
		});
		expect(reg.list().map((p) => p.id)).toEqual(["web"]);
		expect(reg.has("web")).toBe(true);
	});
});
