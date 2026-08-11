import { describe, expect, it } from "vitest";

import { mergeBreakRows } from "./calendar-breaks";

const PEOPLE = [
	{ id: "ana", collegeId: "cornell" },
	{ id: "ben", collegeId: "cornell" },
	{ id: "cass", collegeId: "kennesaw" },
	{ id: "dee", collegeId: null },
];

const USER_BREAKS = [
	{ id: "u1", userId: "ana", label: "Ski trip", startDate: "2027-02-10", endDate: "2027-02-14" },
	{ id: "u2", userId: "dee", label: "Wedding", startDate: "2027-06-05", endDate: "2027-06-06" },
];

const COLLEGE_BREAKS = [
	{
		id: "c1",
		collegeId: "cornell",
		label: "Thanksgiving break",
		startDate: "2026-11-25",
		endDate: "2026-11-29",
	},
	{
		id: "c2",
		collegeId: "kennesaw",
		label: "Spring break",
		startDate: "2027-03-15",
		endDate: "2027-03-19",
	},
];

describe("merging user breaks with institutional ones", () => {
	it("keeps every user-entered break", () => {
		const rows = mergeBreakRows(PEOPLE, USER_BREAKS, COLLEGE_BREAKS);
		const own = rows.filter((row) => row.source === "user");
		// Pinned by id, not by count: an institutional row leaking in as `user` must not pass.
		expect(own.map((row) => row.id).toSorted()).toEqual(["u1", "u2"]);
		expect(own.find((row) => row.id === "u1")).toMatchObject({
			userId: "ana",
			label: "Ski trip",
			startDate: "2027-02-10",
			endDate: "2027-02-14",
		});
	});

	it("still shows a user break for someone with no college", () => {
		const rows = mergeBreakRows(PEOPLE, USER_BREAKS, COLLEGE_BREAKS);
		const dee = rows.filter((row) => row.userId === "dee");
		expect(dee).toHaveLength(1);
		expect(dee[0]).toMatchObject({ id: "u2", source: "user" });
	});

	it("gives every person at a college its institutional breaks, and nobody else", () => {
		const rows = mergeBreakRows(PEOPLE, [], COLLEGE_BREAKS);
		const thanksgiving = rows.filter((row) => row.label === "Thanksgiving break");
		expect(thanksgiving.map((row) => row.userId).toSorted()).toEqual(["ana", "ben"]);
		expect(rows.filter((row) => row.userId === "cass").map((row) => row.label)).toEqual([
			"Spring break",
		]);
		expect(rows.filter((row) => row.userId === "dee")).toEqual([]);
	});

	it("marks institutional rows as such so the editor cannot offer to delete them", () => {
		const rows = mergeBreakRows(PEOPLE, USER_BREAKS, COLLEGE_BREAKS);
		const anas = rows.filter((row) => row.userId === "ana");
		expect(anas.map((row) => row.source).toSorted()).toEqual(["college", "user"]);
	});

	it("gives every row a unique id, since one institutional row is emitted per person", () => {
		const rows = mergeBreakRows(PEOPLE, USER_BREAKS, COLLEGE_BREAKS);
		expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
	});

	it("returns nothing when there is nothing to show", () => {
		// The positive control for every assertion above: an empty grid has to be reachable only
		// when both sources are genuinely empty.
		expect(mergeBreakRows(PEOPLE, [], [])).toEqual([]);
	});
});
