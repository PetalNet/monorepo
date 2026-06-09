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
});
