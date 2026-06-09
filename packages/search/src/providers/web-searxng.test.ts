import { describe, expect, it } from "vitest";

import { createWebProvider } from "./web-searxng.ts";

/** A fake `fetch` that returns a canned SearXNG JSON payload. */
function fakeFetch(payload: unknown, capture?: { url?: string; headers?: Headers }): typeof fetch {
	return ((input: string | URL | Request, init?: RequestInit) => {
		if (capture) {
			capture.url = String(input);
			capture.headers = new Headers(init?.headers);
		}
		return Promise.resolve(
			new Response(JSON.stringify(payload), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
	}) as typeof fetch;
}

describe("createWebProvider (SearXNG)", () => {
	it("maps SearXNG rows into Result shape with ordinal scores", async () => {
		const provider = createWebProvider({
			fetch: fakeFetch({
				results: [
					{ url: "https://a.com", title: "A", content: "snippet A", engine: "duckduckgo" },
					{ url: "https://b.com", title: "B", content: "snippet B", engine: "brave" },
				],
			}),
		});
		const { results } = await provider.query("test", {});
		expect(results).toHaveLength(2);
		expect(results[0]).toMatchObject({
			id: "https://a.com",
			providerId: "web",
			title: "A",
			subtitle: "snippet A",
			url: "https://a.com",
			kind: "web",
		});
		// Ordinal scoring: first beats second.
		expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
	});

	it("scores a lone result at 1 (no divide-by-one degenerate)", async () => {
		const provider = createWebProvider({
			fetch: fakeFetch({ results: [{ url: "https://solo.com", title: "Solo" }] }),
		});
		const { results } = await provider.query("t", {});
		expect(results).toHaveLength(1);
		expect(results[0]?.score).toBe(1);
	});

	it("decays ordinal scores monotonically across many results", async () => {
		const rows = Array.from({ length: 5 }, (_, i) => ({
			url: `https://r${i}.com`,
			title: `R${i}`,
		}));
		const provider = createWebProvider({ fetch: fakeFetch({ results: rows }) });
		const { results } = await provider.query("t", {});
		const scores = results.map((r) => r.score);
		// Strictly descending: each earlier hit outranks the next.
		for (let i = 1; i < scores.length; i++) {
			expect(scores[i - 1]!).toBeGreaterThan(scores[i]!);
		}
	});

	it("falls back to a synthetic id when a row has no url", async () => {
		const provider = createWebProvider({
			fetch: fakeFetch({ results: [{ title: "no url here", content: "snippet" }] }),
		});
		const { results } = await provider.query("t", {});
		expect(results[0]?.id).toBe("web:0");
		expect(results[0]?.url).toBeUndefined();
		expect(results[0]?.title).toBe("no url here");
	});

	it("titles an untitled, url-less row as (untitled)", async () => {
		const provider = createWebProvider({ fetch: fakeFetch({ results: [{ content: "c" }] }) });
		const { results } = await provider.query("t", {});
		expect(results[0]?.title).toBe("(untitled)");
	});

	it("preserves the raw SearXNG row on each result", async () => {
		const provider = createWebProvider({
			fetch: fakeFetch({
				results: [{ url: "https://x.com", title: "X", engine: "brave", category: "general" }],
			}),
		});
		const { results } = await provider.query("t", {});
		expect(results[0]?.raw).toMatchObject({ engine: "brave", category: "general" });
	});

	it("sends the engines param when configured", async () => {
		const cap: { url?: string; headers?: Headers } = {};
		const provider = createWebProvider({
			engines: ["duckduckgo", "brave"],
			fetch: fakeFetch({ results: [] }, cap),
		});
		await provider.query("t", {});
		expect(cap.url).toContain("engines=duckduckgo%2Cbrave");
	});

	it("uses a custom provider id/name/weight when given", async () => {
		const provider = createWebProvider({
			id: "web2",
			name: "Secondary Web",
			weight: 0.5,
			fetch: fakeFetch({ results: [{ url: "https://a.com", title: "A" }] }),
		});
		expect(provider.id).toBe("web2");
		expect(provider.name).toBe("Secondary Web");
		expect(provider.weight).toBe(0.5);
		const { results } = await provider.query("t", {});
		expect(results[0]?.providerId).toBe("web2");
	});

	it("sends the JSON format param and a browser UA", async () => {
		const cap: { url?: string; headers?: Headers } = {};
		const provider = createWebProvider({ fetch: fakeFetch({ results: [] }, cap) });
		await provider.query("hello world", {});
		expect(cap.url).toContain("/search");
		expect(cap.url).toContain("format=json");
		expect(cap.url).toContain("q=hello+world");
		expect(cap.headers?.get("user-agent")).toMatch(/Mozilla/);
	});

	it("parses publishedDate into a timestamp", async () => {
		const provider = createWebProvider({
			fetch: fakeFetch({
				results: [{ url: "https://x.com", title: "X", publishedDate: "2024-01-01T00:00:00Z" }],
			}),
		});
		const { results } = await provider.query("t", {});
		expect(results[0]?.timestamp).toBe(Date.parse("2024-01-01T00:00:00Z"));
	});

	it("respects opts.limit", async () => {
		const provider = createWebProvider({
			fetch: fakeFetch({
				results: [
					{ url: "https://1.com", title: "1" },
					{ url: "https://2.com", title: "2" },
					{ url: "https://3.com", title: "3" },
				],
			}),
		});
		const { results } = await provider.query("t", { limit: 2 });
		expect(results).toHaveLength(2);
	});

	it("throws on a non-OK response", async () => {
		const provider = createWebProvider({
			fetch: (() => Promise.resolve(new Response("nope", { status: 403 }))) as typeof fetch,
		});
		await expect(provider.query("t", {})).rejects.toThrow(/403/);
	});

	it("maps SearXNG category to ResultKind", async () => {
		const provider = createWebProvider({
			fetch: fakeFetch({
				results: [
					{ url: "https://n.com", title: "N", category: "news" },
					{ url: "https://i.com", title: "I", category: "images" },
					{ url: "https://v.com", title: "V", category: "videos" },
					{ url: "https://g.com", title: "G", category: "general" },
					{ url: "https://u.com", title: "U", category: "weather" },
					// Falls back to categories[0] when `category` is absent.
					{ url: "https://c.com", title: "C", categories: ["science"] },
				],
			}),
		});
		const { results } = await provider.query("t", {});
		expect(results.map((r) => r.kind)).toEqual([
			"news",
			"image",
			"video",
			"web",
			"web", // unknown "weather" → web fallback
			"science",
		]);
	});

	it("emits a 'search the web' action with the encoded query", async () => {
		const provider = createWebProvider({
			baseUrl: "https://searx.example",
			fetch: fakeFetch({ results: [{ url: "https://a.com", title: "A" }] }),
		});
		const { actions } = await provider.query("cats & dogs", {});
		expect(actions).toHaveLength(1);
		expect(actions?.[0]).toMatchObject({ id: "web:search", providerId: "web" });
		expect(actions?.[0]?.title).toContain("cats & dogs");
		const raw = actions?.[0]?.raw as { url: string };
		expect(raw.url).toBe("https://searx.example/search?q=cats%20%26%20dogs");
	});

	it("sends the categories param when configured", async () => {
		const cap: { url?: string; headers?: Headers } = {};
		const provider = createWebProvider({
			categories: ["general", "news"],
			fetch: fakeFetch({ results: [] }, cap),
		});
		await provider.query("t", {});
		expect(cap.url).toContain("categories=general%2Cnews");
	});

	it("graceful mode resolves to empty + action instead of throwing", async () => {
		const provider = createWebProvider({
			graceful: true,
			fetch: (() => Promise.reject(new Error("network down"))) as typeof fetch,
		});
		const { results, actions } = await provider.query("t", {});
		expect(results).toHaveLength(0);
		expect(actions).toHaveLength(1);
		expect(actions?.[0]?.id).toBe("web:search");
	});

	it("graceful mode swallows a non-OK response", async () => {
		const provider = createWebProvider({
			graceful: true,
			fetch: (() => Promise.resolve(new Response("nope", { status: 502 }))) as typeof fetch,
		});
		const { results } = await provider.query("t", {});
		expect(results).toHaveLength(0);
	});

	it("aborts the fetch when its own timeout fires", async () => {
		let seenSignal: AbortSignal | undefined;
		const provider = createWebProvider({
			timeoutMs: 5,
			fetch: ((_input: string | URL | Request, init?: RequestInit) => {
				seenSignal = init?.signal ?? undefined;
				// Never resolve on its own; rely on the abort signal to reject.
				return new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
				});
			}) as typeof fetch,
		});
		await expect(provider.query("t", {})).rejects.toBeDefined();
		expect(seenSignal).toBeInstanceOf(AbortSignal);
	});

	it("honors the caller's abort signal", async () => {
		const ac = new AbortController();
		const provider = createWebProvider({
			timeoutMs: 0,
			fetch: ((_input: string | URL | Request, init?: RequestInit) => {
				return new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
				});
			}) as typeof fetch,
		});
		const p = provider.query("t", { signal: ac.signal });
		ac.abort();
		await expect(p).rejects.toThrow(/aborted/);
	});
});
