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

/**
 * The federal-holiday fallback, kept deliberately separate from the blocks above.
 *
 * These rows are the only ones this app invents, so what is pinned here is mostly the shape of
 * _not_ inventing them: for the wrong kind of place, for a day the person already spoke for, and
 * for a caller that never asked.
 */
const AFFILIATED = [
	{ id: "ana", collegeId: "cornell", institutionKind: "college" as const },
	{ id: "sgt", collegeId: "fort-drum", institutionKind: "military" as const },
	{ id: "emp", collegeId: "acme", institutionKind: "work" as const },
	{ id: "oth", collegeId: "somewhere", institutionKind: "other" as const },
	{ id: "none", collegeId: null },
];

/** Rows the app filled in for one person, by label. */
function assumedFor(id: string, rows: ReturnType<typeof mergeBreakRows>) {
	return rows.filter((row) => row.userId === id && row.source === "default");
}

describe("federal holidays are a default for work and military", () => {
	it("fills in all eleven holidays per year for a job and for a unit", () => {
		const rows = mergeBreakRows(AFFILIATED, [], [], [2026, 2027]);
		expect(assumedFor("emp", rows)).toHaveLength(22);
		expect(assumedFor("sgt", rows)).toHaveLength(22);
	});

	it("fills in nothing for a college, for other, or for nobody at all", () => {
		// A college has a real published calendar; `other` asked for nothing to be assumed; a person
		// with no affiliation has said nothing the app could act on.
		const rows = mergeBreakRows(AFFILIATED, [], [], [2026, 2027]);
		expect(assumedFor("ana", rows)).toEqual([]);
		expect(assumedFor("oth", rows)).toEqual([]);
		expect(assumedFor("none", rows)).toEqual([]);
	});

	it("fills in nothing at all when no years were asked for", () => {
		// The control for every assertion above, and the reason the argument defaults to empty: a
		// caller that says nothing about years gets no invented dates rather than a silent yearful.
		expect(mergeBreakRows(AFFILIATED, [], [])).toEqual([]);
	});

	it("marks every filled-in row as a default and never as a person's own or a college's", () => {
		// The whole point. A federal holiday dressed up as `user` or `college` is the app claiming
		// somebody is off when nobody said so.
		const rows = mergeBreakRows(AFFILIATED, [], [], [2026]);
		expect(rows.every((row) => row.source === "default")).toBe(true);
		expect(rows).toHaveLength(22);
	});

	it("uses the observed date, not the statutory one", () => {
		// 2026-07-04 is a Saturday, so the day off is Friday the 3rd, and it says so.
		const rows = mergeBreakRows(AFFILIATED, [], [], [2026]);
		const independence = assumedFor("emp", rows).find((row) =>
			row.label.startsWith("Independence"),
		);
		expect(independence).toMatchObject({
			label: "Independence Day (observed)",
			startDate: "2026-07-03",
			endDate: "2026-07-03",
			source: "default",
		});
	});

	it("gives way to a date the person entered themselves", () => {
		// Thanksgiving 2026 is the 26th. Someone who has already said they are away that week has
		// spoken for the day; a second, weaker row asserting the same thing adds nothing and would
		// survive if they later deleted their own.
		const rows = mergeBreakRows(
			AFFILIATED,
			[{ id: "u1", userId: "emp", label: "Home", startDate: "2026-11-24", endDate: "2026-11-27" }],
			[],
			[2026],
		);
		const labels = assumedFor("emp", rows).map((row) => row.label);
		expect(labels).not.toContain("Thanksgiving Day");
		expect(labels).toHaveLength(10);
		// And only for that person: the sergeant said nothing, so the default still stands for him.
		expect(assumedFor("sgt", rows).map((row) => row.label)).toContain("Thanksgiving Day");
	});

	it("gives every filled-in row an id of its own", () => {
		// One holiday becomes one row per person across three years, and the grid is keyed by id.
		const rows = mergeBreakRows(AFFILIATED, [], [], [2026, 2027, 2028]);
		expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
	});
});
