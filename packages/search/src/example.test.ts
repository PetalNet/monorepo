import { describe, expect, it } from "vitest";

import { runExample } from "./example.ts";

describe("runExample (federated web/SearXNG, mocked)", () => {
	it("federates a mocked SearXNG query end-to-end", async () => {
		const response = await runExample();

		// The web provider participated successfully.
		expect(response.providers).toEqual(["web"]);
		expect(response.errors).toEqual([]);

		// Three mock rows, but two share a URL → deduped to two results.
		expect(response.results).toHaveLength(2);
		expect(response.results.map((r) => r.url)).toEqual([
			"https://en.wikipedia.org/wiki/Distributed_search_engine",
			"https://example.com/news/federated-search",
		]);

		// Category → kind mapping flowed through federation.
		const kinds = new Set(response.results.map((r) => r.kind));
		expect(kinds).toContain("web");
		expect(kinds).toContain("news");

		// Every result carries provenance and a final rank score.
		for (const r of response.results) {
			expect(r.providerId).toBe("web");
			expect(typeof r.rankScore).toBe("number");
		}

		// The "search the web" action surfaced.
		expect(response.actions.some((a) => a.id === "web:search")).toBe(true);
	});
});
