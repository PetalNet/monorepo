import { describe, expect, it } from "vitest";

import { branchQuery } from "../src/query/branch.ts";

describe("investigation branching", () => {
	it("adds the selected mark as a structured filter without mutating the saved query", () => {
		const parent = {
			schema_version: 1 as const,
			mode: "structured" as const,
			from: "events",
			where: { severity: "warn" },
			select: [{ field: "seq", agg: "count" as const, as: "events" }],
		};
		expect(branchQuery(parent, "scope", "lab.fleet.*")).toMatchObject({
			where: { severity: "warn", scope: "lab.fleet.*" },
		});
		expect(parent.where).toEqual({ severity: "warn" });
	});
});
