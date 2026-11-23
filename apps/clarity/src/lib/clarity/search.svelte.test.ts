/* The search state machine through its injected transport: entry building,
   cache restore, error+retry, and the infinite-scroll dedupe/exhausted/refill
   rules. No DOM, no sessionStorage (node env exercises the guards). */
import { describe, expect, it, vi } from "vitest";

import { SearchState } from "./search.svelte";
import { settings } from "./settings.svelte";

interface Page {
	results?: { url: string; title?: string }[];
	answers?: unknown[];
	number_of_results?: number;
}

function transport(pages: Record<string, Page | (() => Page)>) {
	const calls: string[] = [];
	const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);

		calls.push(url);
		const pageno = new URLSearchParams(url.split("?")[1]).get("pageno") ?? "1";
		const hit = pages[pageno];

		if (!hit) {
			throw new Error(`no page ${pageno}`);
		}

		const body = typeof hit === "function" ? hit() : hit;

		return { ok: true, status: 200, json: async () => body } as unknown as Response;
	});

	return { fetchFn, calls };
}

const noMorph = (fn: () => void) => {
	fn();
};

const R = (n: number, prefix = "https://r.example/") => ({
	url: `${prefix}${String(n)}`,
	title: `R${n}`,
});

describe("SearchState.doSearch", () => {
	it("builds the entry from page 1: results, n, trimmed answers, ms", async () => {
		const { fetchFn, calls } = transport({
			"1": {
				results: [R(1), R(2)],
				number_of_results: 240,
				answers: ["plain", { answer: "objform" }, "", { answer: "" }, "third", "fourth"],
			},
		});
		const s = new SearchState(fetchFn);

		await s.doSearch({ query: "cats", fromHome: true, morph: noMorph });
		expect(s.state).toBe("results");
		expect(s.entry!.results).toHaveLength(2);
		expect(s.entry!.n).toBe(240);
		expect(s.entry!.answers).toEqual(["plain", "objform", "third"]); // ≤3, normalized, empties dropped
		expect(s.entry!.ms).toBeGreaterThanOrEqual(0);
		expect(s.curKey).toBe("/?q=cats");
		expect(calls[0]).toContain("/search?q=cats");
		expect(s.activeQuery).toBe("cats");
	});

	it("records recency + private in key and request", async () => {
		const { fetchFn, calls } = transport({ "1": { results: [R(1)] } });
		const s = new SearchState(fetchFn);

		await s.doSearch({ query: "x past:month", priv: true, fromHome: false, morph: noMorph });
		expect(s.timeRange).toBe("month");
		expect(s.activePriv).toBe(true);
		expect(calls[0]).toContain("time_range=month");
		expect(calls[0]).toContain("engines=duckduckgo");
	});

	it("serves a repeat search from the cache without a second fetch", async () => {
		const { fetchFn } = transport({ "1": { results: [R(1)] } });
		const s = new SearchState(fetchFn);

		await s.doSearch({ query: "cats", fromHome: true, morph: noMorph });
		await s.doSearch({ query: "cats", fromHome: false, morph: noMorph });
		// 1 search fetch + the post-render prefetch never fires in node (browser=false)
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it("a fetch error lands in errorHtml and retry() clears the cache slot", async () => {
		let fail = true;
		const { fetchFn } = transport({
			"1": () => {
				if (fail) {
					throw new Error("SearXNG down");
				}

				return { results: [R(1)] };
			},
		});
		const s = new SearchState(fetchFn);

		await s.doSearch({ query: "cats", fromHome: true, morph: noMorph });
		expect(s.errorHtml).toContain("SearXNG down");
		expect(s.entry).toBeNull();
		fail = false;
		let reran = false;

		s.retry(() => (reran = true));
		expect(reran).toBe(true);
	});

	it("restore() hits the cache and re-shows the exact entry", async () => {
		const { fetchFn } = transport({ "1": { results: [R(1)], number_of_results: 9 } });
		const s = new SearchState(fetchFn);

		await s.doSearch({ query: "cats", fromHome: true, morph: noMorph });
		s.reset();
		expect(s.state).toBe("home");
		const e = s.restore("/?q=cats");

		expect(e).not.toBeNull();
		expect(s.state).toBe("results");
		expect(s.entry!.n).toBe(9);
		expect(s.activeQuery).toBe("cats");
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it("restore() misses cleanly for unknown keys", () => {
		const s = new SearchState(transport({}).fetchFn);

		expect(s.restore("/?q=never-seen")).toBeNull();
		expect(s.state).toBe("home");
	});
});

describe("SearchState.loadMore", () => {
	async function seeded(pages: Record<string, Page | (() => Page)>) {
		const t = transport({ "1": { results: [R(1), R(2)], number_of_results: 50 }, ...pages });
		const s = new SearchState(t.fetchFn);

		await s.doSearch({ query: "cats", fromHome: true, morph: noMorph });

		return { s, ...t };
	}

	it("appends the next page deduped by url", async () => {
		const { s } = await seeded({ "2": { results: [R(2), R(3), R(4)] } });
		const fresh = await s.loadMore();

		expect(fresh!.map((r) => r.url)).toEqual([R(3).url, R(4).url]);
		expect(s.entry!.results).toHaveLength(4);
		expect(s.entry!.page).toBe(2);
	});

	it("marks exhausted when a page brings nothing fresh (and stops fetching)", async () => {
		const { s, fetchFn } = await seeded({ "2": { results: [R(1), R(2)] } });

		expect(await s.loadMore()).toBeNull();
		expect(s.entry!.exhausted).toBe(true);
		await s.loadMore();
		expect(fetchFn).toHaveBeenCalledTimes(2); // no fetch after exhausted
	});

	it("keeps refilling while nearBottom and page < 12", async () => {
		const pages: Record<string, Page> = {};

		for (let p = 2; p <= 13; p++) {
			pages[String(p)] = { results: [R(p * 10), R(p * 10 + 1)] };
		}

		const { s, fetchFn } = await seeded(pages);

		await s.loadMore(() => true);

		// recursion is fire-and-forget past the first await; drain it
		await vi.waitFor(() => {
			expect(s.entry!.page).toBe(12);
		});

		expect(fetchFn).toHaveBeenCalledTimes(12); // page1 + pages 2..12; page 13 never fetched
	});

	it("respects the infiniteScroll setting", async () => {
		const { s, fetchFn } = await seeded({ "2": { results: [R(3)] } });

		settings.current.infiniteScroll = false;

		try {
			expect(await s.loadMore()).toBeNull();
			expect(fetchFn).toHaveBeenCalledTimes(1);
		} finally {
			settings.current.infiniteScroll = true;
		}
	});

	it("never paginates image searches", async () => {
		const t = transport({ "1": { results: [R(1)] } });
		const s = new SearchState(t.fetchFn);

		s.category = "images";
		await s.doSearch({ query: "cats", fromHome: true, morph: noMorph });
		expect(await s.loadMore()).toBeNull();
		expect(t.fetchFn).toHaveBeenCalledTimes(1);
	});
});
