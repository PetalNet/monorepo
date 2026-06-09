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
