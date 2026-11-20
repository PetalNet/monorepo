import { describe, expect, it } from "vitest";

import fixture from "./fixtures/quota.json";
import { parseQuotaFeed, quotaStale } from "./quota.js";

describe("quota feed", () => {
	it("reads the scrubbed source capture including over-budget usage", () => {
		const feed = parseQuotaFeed(fixture);

		expect(feed.services).toHaveLength(6);

		expect(
			feed.services
				.find((service) => service.service === "tmobile")
				?.limits.find((limit) => limit.id === "tmobile:priority-week")?.usedPct,
		).toBe(149.3);
	});

	it("marks old and future feeds stale", () => {
		const feed = parseQuotaFeed(fixture);

		expect(quotaStale(feed, feed.generatedAt + 900_000)).toBe(false);
		expect(quotaStale(feed, feed.generatedAt + 900_001)).toBe(true);
		expect(quotaStale(feed, feed.generatedAt - 1)).toBe(true);
	});

	it("preserves service failures without accepting their private error text", () => {
		const feed = parseQuotaFeed({
			generatedAt: 1,
			services: [{ service: "new-service", status: "error", error: "private", limits: [] }],
		});

		expect(feed.services).toEqual([{ service: "new-service", status: "error", limits: [] }]);
	});

	it("rejects malformed limits rather than rendering misleading numbers", () => {
		expect(() =>
			parseQuotaFeed({
				generatedAt: 1,
				services: [
					{ service: "x", status: "ok", limits: [{ id: "x", label: "x", usedPct: "100" }] },
				],
			}),
		).toThrow();
	});
});
