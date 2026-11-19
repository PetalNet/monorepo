import { describe, expect, it } from "vitest";

import { parseGitHubActionsUsage } from "./quota-sources.ts";

describe("GitHub included compute billing", () => {
	it.each([
		{ sku: "Actions Windows", quantity: 1_000, pricePerUnit: 0.01, expected: 83.3 },
		{ sku: "Actions macOS", quantity: 100, pricePerUnit: 0.062, expected: 51.7 },
	])("uses the billed rate for $sku", ({ expected, ...usage }) => {
		const report = parseGitHubActionsUsage(
			{ usageItems: [{ product: "actions", unitType: "Minutes", ...usage }] },
			new Set(),
			2026,
			11,
			12,
			"PetalNet",
		);

		expect(report.limits[0]?.usedPct).toBe(expected);
	});

	it("uses gross cost before allowance discounts and excludes public runners and storage", () => {
		const report = parseGitHubActionsUsage(
			{
				usageItems: [
					{
						product: "actions",
						unitType: "Minutes",
						grossAmount: 10,
						netAmount: 0,
						quantity: 1_000,
						pricePerUnit: 0.006,
					},
					{ product: "actions", unitType: "Minutes", grossAmount: 100, repositoryName: "public" },
					{ product: "actions", unitType: "GigabyteHours", grossAmount: 100 },
				],
			},
			new Set(["public"]),
			2026,
			11,
			12,
			"PetalNet",
		);

		expect(report.limits[0]?.usedPct).toBe(83.3);
		expect(report.summary).toContain("$10.00/$12.00 private compute");
	});

	it("does not invent a runner multiplier when billing amounts are missing", () => {
		const report = parseGitHubActionsUsage(
			{ usageItems: [{ product: "actions", unitType: "Minutes", quantity: 1_000 }] },
			new Set(),
			2026,
			11,
			12,
			"PetalNet",
		);

		expect(report.status).toBe("error");
		expect(report.limits).toEqual([]);
	});
});
