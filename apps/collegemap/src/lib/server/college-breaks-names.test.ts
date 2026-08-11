import { collegeNames } from "$lib/collegeNames";
import { describe, expect, it } from "vitest";

import { COLLEGE_NAME_MAP } from "./college-breaks-import";

// The importer joins scraped school names to college rows by EXACT name and throws on a miss, so a
// map value that is not a real college name aborts the whole import before a single row is written.
// One entry shipped that way: the source calls it "University of Missouri-Kansas City (UMKC)" and
// the value repeated the parenthetical, which no college row carries.
describe("COLLEGE_NAME_MAP", () => {
	const canonical = new Set<string>(collegeNames);

	it("names a real college on every right-hand side", () => {
		const unknown = Object.entries(COLLEGE_NAME_MAP)
			.filter(([, dbName]) => !canonical.has(dbName))
			.map(([source, dbName]) => `${source} -> ${dbName}`);
		expect(unknown).toEqual([]);
	});

	it("has a canonical list to check against", () => {
		// Without this the test above passes just as happily against an empty list.
		expect(canonical.size).toBeGreaterThan(1000);
		expect(canonical.has("University of Missouri-Kansas City")).toBe(true);
		expect(canonical.has("University of Missouri-Kansas City (UMKC)")).toBe(false);
	});

	it("maps every source school exactly once", () => {
		const values = Object.values(COLLEGE_NAME_MAP);
		expect(new Set(values).size).toBe(values.length);
	});
});
