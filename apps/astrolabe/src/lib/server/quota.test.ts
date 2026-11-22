import { describe, expect, it } from "vitest";

import capture from "../fixtures/quota.json";
import { parseQuotaFeed } from "./quota.js";

const feedOf = (service: Record<string, unknown>) => ({ generatedAt: 1, services: [service] });

describe("quota feed", () => {
	it("reads a capture of the host job's feed, usage past the limit included", () => {
		const feed = parseQuotaFeed(capture);

		expect(feed.services.map((service) => service.service)).toEqual([
			"claude",
			"google-ai",
			"codex",
			"cloudflare-ai",
			"github-actions",
			"tmobile",
		]);

		expect(feed.services.at(-1)?.limits.at(-1)).toEqual({
			id: "tmobile:priority-week",
			label: "T-Mobile priority week",
			usedPct: 149.3,
			resetAtMs: 1_795_413_600_000,
			windowMinutes: null,
		});
	});

	it("reads a service's display name and a limit's window length", () => {
		const limit = { id: "google-ai:gemini:5h", label: "Gemini", usedPct: 90, windowMinutes: 300 };
		const feed = parseQuotaFeed(
			feedOf({ service: "google-ai", label: "Google AI", status: "ok", limits: [limit] }),
		);

		expect(feed.services).toEqual([
			{
				service: "google-ai",
				label: "Google AI",
				status: "ok",
				limits: [{ ...limit, resetAtMs: null }],
			},
		]);
	});

	it("keeps a service's failure and leaves its private error text behind", () => {
		const feed = parseQuotaFeed(
			feedOf({ service: "new-service", status: "error", error: "private", limits: [] }),
		);

		expect(feed.services).toEqual([
			{ service: "new-service", label: null, status: "error", limits: [] },
		]);
	});

	it("refuses a malformed feed rather than show a figure that might be wrong", () => {
		const limit = { id: "x:week", label: "Week", usedPct: 100 };
		const service = { service: "x", status: "ok", limits: [limit] };
		const malformed = [
			feedOf({ ...service, limits: [{ ...limit, usedPct: "100" }] }),
			feedOf({ ...service, limits: [{ ...limit, usedPct: -1 }] }),
			feedOf({ ...service, limits: [{ ...limit, label: "" }] }),
			feedOf({ ...service, status: "paused" }),
			feedOf({ ...service, service: "x y" }),
			{ generatedAt: 1, services: [service, service] },
			{ services: [service] },
		];

		expect(parseQuotaFeed(feedOf(service)).services).toHaveLength(1);

		for (const feed of malformed) {
			expect(() => parseQuotaFeed(feed)).toThrow();
		}
	});
});
