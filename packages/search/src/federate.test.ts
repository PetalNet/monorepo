import { describe, expect, it } from "vitest";

import { search } from "./federate.ts";
import { ProviderRegistry } from "./registry.ts";
import type { Provider, QueryOptions, QueryResponse, Result } from "./types.ts";

/** A fake, network-free provider that returns canned results after a delay. */
function fakeProvider(
	id: string,
	results: readonly Partial<Result>[],
	opts: { weight?: number; delayMs?: number; throws?: boolean } = {},
): Provider {
	return {
		id,
		name: id,
		...(opts.weight !== undefined ? { weight: opts.weight } : {}),
		async query(_q: string, queryOpts: QueryOptions): Promise<QueryResponse> {
			if (opts.delayMs) {
				await new Promise<void>((resolve, reject) => {
					const t = setTimeout(resolve, opts.delayMs);
					queryOpts.signal?.addEventListener("abort", () => {
						clearTimeout(t);
						reject(new Error("aborted"));
					});
				});
			}
			if (opts.throws) throw new Error(`${id} boom`);
			return {
				results: results.map((r, i) => ({
					id: r.id ?? `${id}-${i}`,
					providerId: id,
					title: r.title ?? `${id} ${i}`,
					score: r.score ?? 0.5,
					kind: r.kind ?? "web",
					...(r.url !== undefined ? { url: r.url } : {}),
					...(r.timestamp !== undefined ? { timestamp: r.timestamp } : {}),
				})),
			};
		},
	};
}

describe("search (federation core)", () => {
	it("fans out to all providers and merges results", async () => {
		const res = await search("hi", {
			providers: [
				fakeProvider("a", [{ score: 0.9 }, { score: 0.1 }]),
				fakeProvider("b", [{ score: 0.5 }]),
			],
		});
		expect(res.providers).toEqual(["a", "b"]);
		expect(res.errors).toHaveLength(0);
		expect(res.results).toHaveLength(3);
	});

	it("ranks by weight × score (highest first)", async () => {
		const res = await search("hi", {
			providers: [
				fakeProvider("low", [{ id: "x", score: 0.9 }], { weight: 0.1 }),
				fakeProvider("high", [{ id: "y", score: 0.5 }], { weight: 2 }),
			],
		});
		// high: 2*0.5=1.0 beats low: 0.1*0.9=0.09
		expect(res.results[0]?.providerId).toBe("high");
		expect(res.results[0]?.rankScore).toBeCloseTo(1.0);
	});

	it("isolates a throwing provider — query still succeeds", async () => {
		const res = await search("hi", {
			providers: [fakeProvider("ok", [{ score: 0.5 }]), fakeProvider("bad", [], { throws: true })],
		});
		expect(res.providers).toEqual(["ok"]);
		expect(res.results).toHaveLength(1);
		expect(res.errors).toHaveLength(1);
		expect(res.errors[0]?.providerId).toBe("bad");
		expect(res.errors[0]?.reason).toBe("error");
	});

	it("times out a slow provider without sinking the fast one", async () => {
		const res = await search("hi", {
			perProviderTimeoutMs: 20,
			providers: [
				fakeProvider("fast", [{ score: 0.5 }]),
				fakeProvider("slow", [{ score: 0.9 }], { delayMs: 1000 }),
			],
		});
		expect(res.providers).toEqual(["fast"]);
		expect(res.errors[0]?.providerId).toBe("slow");
		expect(res.errors[0]?.reason).toBe("timeout");
	});

	it("dedupes by url, keeping the higher-priority provider", async () => {
		const res = await search("hi", {
			providers: [
				fakeProvider("first", [{ id: "1", url: "https://example.com/page", score: 0.5 }]),
				fakeProvider("second", [{ id: "2", url: "https://example.com/page/", score: 0.9 }]),
			],
		});
		expect(res.results).toHaveLength(1);
		expect(res.results[0]?.providerId).toBe("first");
	});

	it("dedupes by providerId:id within one provider (same id twice)", async () => {
		const res = await search("hi", {
			providers: [
				fakeProvider("p", [
					{ id: "dup", score: 0.9 },
					{ id: "dup", score: 0.1 },
				]),
			],
		});
		// Same providerId:id key collides → first-seen kept, second dropped.
		expect(res.results).toHaveLength(1);
		expect(res.results[0]?.score).toBe(0.9);
	});

	it("does NOT dedupe identical ids across different providers", async () => {
		const res = await search("hi", {
			providers: [
				fakeProvider("a", [{ id: "shared", score: 0.5 }]),
				fakeProvider("b", [{ id: "shared", score: 0.5 }]),
			],
		});
		// id is only unique WITHIN a provider; providerId:id keys differ → both kept.
		expect(res.results).toHaveLength(2);
	});

	it("isolates BOTH a thrower and a timeout while a healthy provider returns", async () => {
		const res = await search("hi", {
			perProviderTimeoutMs: 20,
			providers: [
				fakeProvider("ok", [{ score: 0.5 }]),
				fakeProvider("boom", [], { throws: true }),
				fakeProvider("slow", [{ score: 0.9 }], { delayMs: 1000 }),
			],
		});
		expect(res.providers).toEqual(["ok"]);
		expect(res.results).toHaveLength(1);
		const byId = Object.fromEntries(res.errors.map((e) => [e.providerId, e.reason]));
		expect(byId).toEqual({ boom: "error", slow: "timeout" });
	});

	it("is deterministic across calls and provider ordering for tied scores", async () => {
		const build = (order: readonly [string, string]) =>
			search("hi", {
				providers: [
					fakeProvider(order[0], [{ id: order[0], score: 0.5, url: `https://${order[0]}.com` }]),
					fakeProvider(order[1], [{ id: order[1], score: 0.5, url: `https://${order[1]}.com` }]),
				],
			});
		const first = await build(["a", "b"]);
		const again = await build(["a", "b"]);
		// Same inputs → byte-identical ordering.
		expect(again.results.map((r) => r.id)).toEqual(first.results.map((r) => r.id));
		// Tie broken by provider (registration) order: a before b.
		expect(first.results.map((r) => r.providerId)).toEqual(["a", "b"]);
	});

	it("respects the final limit", async () => {
		const res = await search("hi", {
			limit: 2,
			providers: [fakeProvider("a", [{ score: 0.9 }, { score: 0.8 }, { score: 0.7 }])],
		});
		expect(res.results).toHaveLength(2);
	});

	it("short-circuits on empty query without calling providers", async () => {
		let called = false;
		const spy: Provider = {
			id: "spy",
			name: "spy",
			async query() {
				called = true;
				return { results: [] };
			},
		};
		const res = await search("   ", { providers: [spy] });
		expect(called).toBe(false);
		expect(res.results).toHaveLength(0);
	});

	it("accepts a ProviderRegistry", async () => {
		const reg = new ProviderRegistry();
		reg.register(fakeProvider("a", [{ score: 0.5 }]));
		const res = await search("hi", { providers: reg });
		expect(res.providers).toEqual(["a"]);
	});

	it("an outer abort signal cancels providers", async () => {
		const ctrl = new AbortController();
		const p = search("hi", {
			signal: ctrl.signal,
			perProviderTimeoutMs: 10_000,
			providers: [fakeProvider("slow", [{ score: 0.5 }], { delayMs: 5000 })],
		});
		ctrl.abort();
		const res = await p;
		expect(res.providers).toHaveLength(0);
		expect(res.errors[0]?.providerId).toBe("slow");
	});
});
