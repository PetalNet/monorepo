import { afterEach, describe, expect, it } from "vitest";

import { buildMonthView, toParticipants } from "../calendar";
import { toDay, weekdayOf } from "../dates";
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

/** One person, no college, so a returned row is unambiguously the break under test. */
const SOLO = [{ id: "ana", collegeId: null }];

function ownBreak(startDate: string, endDate: string) {
	const rows = mergeBreakRows(
		SOLO,
		[{ id: "u1", userId: "ana", label: "Break", startDate, endDate }],
		[],
	);
	expect(rows).toHaveLength(1);
	return rows[0];
}

// November 2026 starts on a Sunday, so 11-23 to 11-29 is a whole Mon-to-Sun week and every weekday
// boundary can be named with a real date from the Thanksgiving the source calendars disagree about.
// The fixed start, 2026-11-20, is a Friday: a Friday start never moves, so these cases isolate the
// end of the break.
const END_CASES = [
	{ weekday: "Monday", endDate: "2026-11-23", extended: "2026-11-23" },
	{ weekday: "Tuesday", endDate: "2026-11-24", extended: "2026-11-24" },
	{ weekday: "Wednesday", endDate: "2026-11-25", extended: "2026-11-25" },
	{ weekday: "Thursday", endDate: "2026-11-26", extended: "2026-11-26" },
	{ weekday: "Friday", endDate: "2026-11-27", extended: "2026-11-29" },
	{ weekday: "Saturday", endDate: "2026-11-28", extended: "2026-11-29" },
	{ weekday: "Sunday", endDate: "2026-11-29", extended: "2026-11-29" },
];

// The mirror week: 2026-12-14 to 2026-12-20 is Mon to Sun. The fixed end, 2026-12-24, is a
// Thursday, which never moves, so these cases isolate the start of the break.
const START_CASES = [
	{ weekday: "Monday", startDate: "2026-12-14", extended: "2026-12-12" },
	{ weekday: "Tuesday", startDate: "2026-12-15", extended: "2026-12-15" },
	{ weekday: "Wednesday", startDate: "2026-12-16", extended: "2026-12-16" },
	{ weekday: "Thursday", startDate: "2026-12-17", extended: "2026-12-17" },
	{ weekday: "Friday", startDate: "2026-12-18", extended: "2026-12-18" },
	{ weekday: "Saturday", startDate: "2026-12-19", extended: "2026-12-19" },
	{ weekday: "Sunday", startDate: "2026-12-20", extended: "2026-12-19" },
];

describe("a break that touches a weekend covers the whole of it", () => {
	it.each(END_CASES)(
		"ending $weekday $endDate is shown through $extended",
		({ endDate, extended }) => {
			expect(ownBreak("2026-11-20", endDate)).toMatchObject({
				startDate: "2026-11-20",
				endDate: extended,
			});
		},
	);

	it.each(START_CASES)(
		"starting $weekday $startDate is shown from $extended",
		({ startDate, extended }) => {
			expect(ownBreak(startDate, "2026-12-24")).toMatchObject({
				startDate: extended,
				endDate: "2026-12-24",
			});
		},
	);

	it("extends both ends of the same break in one pass", () => {
		// The case a rule applied one-at-a-time-and-return gets wrong: Mon 12-14 to Fri 12-18 is a
		// whole working week, and the weekends on either side belong to it.
		expect(ownBreak("2026-12-14", "2026-12-18")).toMatchObject({
			startDate: "2026-12-12",
			endDate: "2026-12-20",
		});
	});

	it("extends a span of several weeks by its ends alone", () => {
		// Winter break: 2026-12-18 is a Friday start, which stays put, and 2027-01-08 is a Friday
		// end, which does not. The run crosses a year boundary on the way.
		expect(ownBreak("2026-12-18", "2027-01-08")).toMatchObject({
			startDate: "2026-12-18",
			endDate: "2027-01-10",
		});
	});

	it("extends institutional rows for every person at the college", () => {
		// Truman State publishes Thanksgiving as ending Fri 11-27; Cornell publishes Sun 11-29. The
		// same real break, so the grid has to show the same end for both.
		const rows = mergeBreakRows(
			[
				{ id: "ana", collegeId: "cornell" },
				{ id: "ben", collegeId: "cornell" },
				{ id: "eve", collegeId: "truman" },
			],
			[],
			[
				...COLLEGE_BREAKS,
				{
					id: "c3",
					collegeId: "truman",
					label: "Thanksgiving break",
					startDate: "2026-11-25",
					endDate: "2026-11-27",
				},
			],
		);
		const thanksgiving = rows.filter((row) => row.label === "Thanksgiving break");
		expect(thanksgiving.map((row) => `${row.userId}:${row.endDate}`).toSorted()).toEqual([
			"ana:2026-11-29",
			"ben:2026-11-29",
			"eve:2026-11-29",
		]);
	});

	it("extends the start of an institutional row too", () => {
		// Kennesaw's spring break runs Mon 2027-03-15 to Fri 2027-03-19, so both weekends are part
		// of it.
		const rows = mergeBreakRows([{ id: "cass", collegeId: "kennesaw" }], [], [COLLEGE_BREAKS[1]]);
		expect(rows.map((row) => `${row.startDate}..${row.endDate}`)).toEqual([
			"2027-03-13..2027-03-21",
		]);
	});

	it("leaves a break that sits inside the week alone", () => {
		// The control for every case above: extending everything would pass them too, and would be
		// just as wrong. 2027-03-16 is a Tuesday and 2027-03-17 a Wednesday.
		const rows = mergeBreakRows(
			[{ id: "cass", collegeId: "kennesaw" }],
			[],
			[
				{
					id: "c4",
					collegeId: "kennesaw",
					label: "Spring break",
					startDate: "2027-03-16",
					endDate: "2027-03-17",
				},
			],
		);
		expect(rows.map((row) => `${row.startDate}..${row.endDate}`)).toEqual([
			"2027-03-16..2027-03-17",
		]);
	});
});

// The same Mon-to-Sun week again, one day at a time.
const SINGLE_DAY_CASES = [
	{ weekday: "Monday", iso: "2026-11-23" },
	{ weekday: "Tuesday", iso: "2026-11-24" },
	{ weekday: "Wednesday", iso: "2026-11-25" },
	{ weekday: "Thursday", iso: "2026-11-26" },
	{ weekday: "Friday", iso: "2026-11-27" },
	{ weekday: "Saturday", iso: "2026-11-28" },
	{ weekday: "Sunday", iso: "2026-11-29" },
];

describe("a single day off is a single day off", () => {
	// A day off in the middle of an otherwise ordinary week says nothing about the weekend around
	// it, and the calendars are full of one-day holidays.
	it.each(SINGLE_DAY_CASES)("leaves a lone $weekday, $iso, alone", ({ iso }) => {
		expect(ownBreak(iso, iso)).toMatchObject({ startDate: iso, endDate: iso });
	});

	it("keeps Labor Day a single Monday", () => {
		// 2026-09-07, and every college in the data has it. The first thing anyone will check.
		expect(ownBreak("2026-09-07", "2026-09-07")).toMatchObject({
			startDate: "2026-09-07",
			endDate: "2026-09-07",
		});
	});

	it("keeps Good Friday a single Friday", () => {
		// Where the guard and the forward rule collide: 2027-03-26 is a Friday, and without the
		// single-day guard it would swallow the weekend after it.
		expect(ownBreak("2027-03-26", "2027-03-26")).toMatchObject({
			startDate: "2027-03-26",
			endDate: "2027-03-26",
		});
	});

	it("still extends the two-day break that starts on the same day", () => {
		// The control for the guard: the rule is about length, not about the weekday. Fri 2027-03-26
		// to Sat 2027-03-27 is two days, so it reaches the Sunday.
		expect(ownBreak("2027-03-26", "2027-03-27")).toMatchObject({
			startDate: "2027-03-26",
			endDate: "2027-03-28",
		});
	});

	it("keeps a single-day institutional holiday to one day", () => {
		const rows = mergeBreakRows(
			[{ id: "cass", collegeId: "kennesaw" }],
			[],
			[
				{
					id: "c5",
					collegeId: "kennesaw",
					label: "Labor Day",
					startDate: "2026-09-07",
					endDate: "2026-09-07",
				},
			],
		);
		expect(rows.map((row) => `${row.startDate}..${row.endDate}`)).toEqual([
			"2026-09-07..2026-09-07",
		]);
	});
});

/** One school, so a returned row is unambiguously the institutional break under test. */
function collegeBreak(startDate: string, endDate: string, label = "Closed") {
	const rows = mergeBreakRows(
		[{ id: "kc", collegeId: "kcai" }],
		[],
		[{ id: "c1", collegeId: "kcai", label, startDate, endDate }],
	);
	expect(rows).toHaveLength(1);
	return rows[0];
}

/**
 * The shapes the rule declines to touch, and why declining is the rule working.
 *
 * Kansas City Art Institute writes its closures weekend-inclusive already, and all six of its
 * rendered rows come through untouched. Its Labor Day closure is the interesting one: it is not a
 * single day, so the guard does not exempt it, and it is the one shape both clauses pass over. It
 * starts on a Saturday, which the backward rule ignores, and ends on a Monday, which the forward
 * rule ignores. Right on both counts — the weekend it touches is the one already inside it, and the
 * next one is five days away.
 */
describe("a break that already contains the weekend it touches", () => {
	it("leaves a Saturday-to-Monday closure exactly as published", () => {
		// KCAI, "Labor Day holiday (campus closed)", 2026-09-05 to 2026-09-07.
		expect(collegeBreak("2026-09-05", "2026-09-07")).toMatchObject({
			startDate: "2026-09-05",
			endDate: "2026-09-07",
		});
	});

	it("brings the Sunday-start version of the same closure to the same span", () => {
		// The control, and the reason the rule exists at all: a school that publishes the same real
		// closure as Sun-to-Mon is not open on the Saturday either. One day later at the start, and
		// the backward rule reaches the same Saturday KCAI wrote down by hand. Two calendars, one
		// rendered span.
		expect(collegeBreak("2026-09-06", "2026-09-07")).toMatchObject({
			startDate: "2026-09-05",
			endDate: "2026-09-07",
		});
	});

	it("leaves a span that begins and ends on a weekend day alone", () => {
		// KCAI's spring break, 2027-03-13 Sat to 2027-03-21 Sun: nine days with a weekend at each
		// end already. Kennesaw publishes the same break as Mon 03-15 to Fri 03-19 and the rule
		// stretches it onto exactly these dates, which is the case above at nine days' length.
		expect(collegeBreak("2027-03-13", "2027-03-21")).toMatchObject({
			startDate: "2027-03-13",
			endDate: "2027-03-21",
		});
	});

	it("leaves the derived Tuesday-to-Sunday Thanksgiving span alone", () => {
		// Rose-Hulman's break is inferred from its term boundaries rather than published, and it
		// lands on 2026-11-24 Tue to 2026-11-29 Sun. Neither end is one the rule moves, which is
		// what makes it one of the eight schools already covering the Thanksgiving weekend before
		// any stretching happens.
		expect(collegeBreak("2026-11-24", "2026-11-29")).toMatchObject({
			startDate: "2026-11-24",
			endDate: "2026-11-29",
		});
	});
});

describe("extending a break is arithmetic no timezone can move", () => {
	const originalTz = process.env.TZ;

	afterEach(() => {
		if (originalTz === undefined) delete process.env.TZ;
		else process.env.TZ = originalTz;
	});

	// West of Greenwich, `new Date('2026-11-27')` is Thursday evening, so an implementation that
	// reads the weekday with local getters never sees a Friday and extends nothing at all.
	it("still sees Friday from a timezone behind UTC", () => {
		process.env.TZ = "America/Los_Angeles";
		expect(ownBreak("2026-11-25", "2026-11-27").endDate).toBe("2026-11-29");
	});

	it("still sees Monday from a timezone behind UTC", () => {
		process.env.TZ = "America/Los_Angeles";
		expect(ownBreak("2026-09-07", "2026-09-09").startDate).toBe("2026-09-05");
	});

	it("does not invent a Friday from a timezone ahead of UTC", () => {
		process.env.TZ = "Pacific/Kiritimati";
		expect(ownBreak("2026-11-24", "2026-11-26").endDate).toBe("2026-11-26");
	});

	it("lands on the right day across a spring-forward Sunday", () => {
		// 2027-03-14 is 23 hours long in Los Angeles, so adding two days as milliseconds and reading
		// the result locally gives 2027-03-13.
		process.env.TZ = "America/Los_Angeles";
		expect(ownBreak("2027-03-08", "2027-03-12").endDate).toBe("2027-03-14");
	});

	it("reaches back across a spring-forward Sunday", () => {
		process.env.TZ = "America/Los_Angeles";
		expect(ownBreak("2027-03-15", "2027-03-19").startDate).toBe("2027-03-13");
	});

	it("lands on the right day across a fall-back Sunday", () => {
		// The mirror: 2026-11-01 is 25 hours long, and a Saturday end has to reach it.
		process.env.TZ = "America/Los_Angeles";
		expect(ownBreak("2026-10-26", "2026-10-31").endDate).toBe("2026-11-01");
	});

	it("reaches back across a fall-back Sunday", () => {
		process.env.TZ = "America/Los_Angeles";
		expect(ownBreak("2026-11-02", "2026-11-05").startDate).toBe("2026-10-31");
	});
});

describe("a person off twice over is still one person", () => {
	// Someone can hold their own break and their college's over the same days, and extending both
	// makes the overlap larger. The grid counts people, not rows, and has to keep doing so.
	const people = [
		{ id: "ana", collegeId: "truman" },
		{ id: "ben", collegeId: "cornell" },
	];
	const overlapping = mergeBreakRows(
		people,
		[{ id: "u1", userId: "ana", label: "Home", startDate: "2026-11-25", endDate: "2026-11-27" }],
		[
			{
				id: "c3",
				collegeId: "truman",
				label: "Thanksgiving break",
				startDate: "2026-11-25",
				endDate: "2026-11-27",
			},
			{
				id: "c1",
				collegeId: "cornell",
				label: "Thanksgiving break",
				startDate: "2026-11-25",
				endDate: "2026-11-29",
			},
		],
	);

	it("counts the doubled-up person once on the extended days", () => {
		const view = buildMonthView(toParticipants(people, overlapping), "2026-11-01");
		const cells = new Map(view.weeks.flat().map((cell) => [cell.iso, cell]));
		expect(view.countedIds).toEqual(["ana", "ben"]);
		expect(cells.get("2026-11-28")).toMatchObject({ freeCount: 2, allFree: true });
		expect(cells.get("2026-11-29")).toMatchObject({ freeCount: 2, allFree: true });
	});

	it("gives the same day count as the person who is off only once", () => {
		// Ana holds three rows' worth of the same days; Ben holds one. Neither is off for longer.
		const view = buildMonthView(toParticipants(people, overlapping), "2026-11-01");
		const daysOff = (id: string) =>
			view.weeks.flat().filter((cell) => cell.inMonth && cell.freeIds.includes(id)).length;
		expect(daysOff("ana")).toBe(5);
		expect(daysOff("ben")).toBe(5);
	});
});

/**
 * Where the weekend rule and the filled-in holidays meet.
 *
 * Two changes landed a few minutes apart, and between them they raise a question neither answers on
 * its own: the weekend rule stretches a break that touches a weekend, and the fallback invents rows
 * the app is only guessing at. Does a guess get stretched? And now that a person's own break can
 * reach further than they wrote it, can it swallow a guess it used to leave standing?
 *
 * Both answers are no, and neither is a coincidence, which is what the first two cases pin: every
 * observed federal holiday is exactly one day long, and none of them ever lands on a weekend. The
 * single-day guard follows from the first; the second means that stretching — which only ever adds
 * Saturdays and Sundays — cannot reach a holiday it did not already cover.
 */
const WORKER = [{ id: "emp", collegeId: "acme", institutionKind: "work" as const }];

/** Four decades, because the generator floats six of the eleven and moves a seventh. */
const MANY_YEARS = Array.from({ length: 41 }, (_, index) => 2000 + index);

function landsOnAWeekend(row: { startDate: string }): boolean {
	const weekday = weekdayOf(toDay(row.startDate));
	return weekday === 0 || weekday === 6;
}

describe("the weekend rule and the filled-in holidays", () => {
	it("never fills in a holiday longer than a single day", () => {
		const rows = mergeBreakRows(WORKER, [], [], MANY_YEARS);
		// The denominator, so an empty result below means "looked and found none" rather than
		// "looked at nothing": eleven holidays a year, for every year asked for.
		expect(rows).toHaveLength(11 * MANY_YEARS.length);
		const multiDay = rows.filter((row) => row.startDate !== row.endDate);
		expect(multiDay.map((row) => `${row.label} ${row.startDate}..${row.endDate}`)).toEqual([]);

		// And the control for the filter itself, which has to be able to find one: a person's own
		// Mon-to-Fri week is five days before the weekend rule touches it and nine after.
		const withOwn = mergeBreakRows(
			WORKER,
			[{ id: "u1", userId: "emp", label: "Leave", startDate: "2026-03-02", endDate: "2026-03-06" }],
			[],
			[2026],
		);
		expect(withOwn.filter((row) => row.startDate !== row.endDate).map((row) => row.label)).toEqual([
			"Leave",
		]);
	});

	it("never fills in a holiday that lands on a weekend", () => {
		// The reason a stretched break cannot reach one. 5 U.S.C. 6103 moves a Saturday holiday to
		// the Friday before and a Sunday one to the Monday after, and this pins that the generator
		// really does it, for every holiday of every year the app could ask for.
		const rows = mergeBreakRows(WORKER, [], [], MANY_YEARS);
		expect(rows).toHaveLength(11 * MANY_YEARS.length);
		expect(rows.filter(landsOnAWeekend).map((row) => `${row.label} ${row.startDate}`)).toEqual([]);

		// The control: the same predicate over a Saturday somebody entered themselves does find it.
		const withSaturday = mergeBreakRows(
			WORKER,
			[
				{
					id: "u1",
					userId: "emp",
					label: "Saturday",
					startDate: "2026-11-28",
					endDate: "2026-11-28",
				},
			],
			[],
			[2026],
		);
		expect(withSaturday.filter(landsOnAWeekend).map((row) => row.label)).toEqual(["Saturday"]);
	});

	it("leaves a filled-in holiday on a Friday exactly where it is", () => {
		// The direct answer to "does a default row get stretched?". Three of the eleven fall on a
		// Friday in 2026 — Juneteenth, Independence Day observed early off its Saturday, and
		// Christmas — and a Friday end is precisely what the forward rule extends. The single-day
		// guard holds them all, and it should: a lone public holiday says nothing about the weekend
		// around it. That is the guard's own stated reason, and a federal holiday is its clearest
		// case.
		const rows = mergeBreakRows(WORKER, [], [], [2026]);
		const spans = rows
			.filter((row) => ["2026-06-19", "2026-07-03", "2026-12-25"].includes(row.startDate))
			.map((row) => `${row.label} ${row.startDate}..${row.endDate}`);
		expect(spans).toEqual([
			"Juneteenth National Independence Day 2026-06-19..2026-06-19",
			"Independence Day (observed) 2026-07-03..2026-07-03",
			"Christmas Day 2026-12-25..2026-12-25",
		]);

		// A Monday one too, for the backward rule: Labor Day 2026 is Mon 09-07.
		expect(rows.find((row) => row.label === "Labor Day")).toMatchObject({
			startDate: "2026-09-07",
			endDate: "2026-09-07",
			source: "default",
		});

		// The control that the forward rule is switched on in this very call rather than absent: the
		// same merge stretches a person's own Friday-ending break to the Sunday.
		const alsoOwn = mergeBreakRows(
			WORKER,
			[{ id: "u1", userId: "emp", label: "Trip", startDate: "2026-07-01", endDate: "2026-07-03" }],
			[],
			[2026],
		);
		expect(alsoOwn.find((row) => row.id === "u1")).toMatchObject({
			startDate: "2026-07-01",
			endDate: "2026-07-05",
		});
	});

	it("does not let a stretched break swallow a holiday it never covered", () => {
		// The interaction neither change tested on its own. Independence Day 2026 is observed on
		// Friday 07-03. A break starting Mon 07-06 now reaches back to Sat 07-04 — one day short of
		// it, and short on purpose, because what the rule adds is weekend days and an observed
		// federal holiday is never on one.
		const rows = mergeBreakRows(
			WORKER,
			[{ id: "u1", userId: "emp", label: "Home", startDate: "2026-07-06", endDate: "2026-07-08" }],
			[],
			[2026],
		);
		// The positive control, in the same call: the break really was stretched, so what follows is
		// about the holiday surviving and not about the rule being switched off.
		expect(rows.find((row) => row.id === "u1")).toMatchObject({
			startDate: "2026-07-04",
			endDate: "2026-07-08",
		});
		const assumed = rows.filter((row) => row.source === "default");
		expect(assumed.map((row) => row.label)).toContain("Independence Day (observed)");
		expect(assumed).toHaveLength(11);
	});

	it("still drops a holiday the person really did speak for", () => {
		// The other side of the control above, so "eleven survived" is not just the fallback
		// ignoring `own` entirely. Mon 07-06 back to Sat 07-04 leaves 07-03 standing; writing the
		// break from Thu 07-02 covers it, and the guess goes.
		const rows = mergeBreakRows(
			WORKER,
			[{ id: "u1", userId: "emp", label: "Home", startDate: "2026-07-02", endDate: "2026-07-08" }],
			[],
			[2026],
		);
		const assumed = rows.filter((row) => row.source === "default");
		expect(assumed.map((row) => row.label)).not.toContain("Independence Day (observed)");
		expect(assumed).toHaveLength(10);
	});

	it("puts all three sources on the grid, each by its own rule", () => {
		const rows = mergeBreakRows(
			[
				{ id: "ana", collegeId: "kennesaw", institutionKind: "college" as const },
				{ id: "emp", collegeId: "acme", institutionKind: "work" as const },
			],
			[{ id: "u1", userId: "emp", label: "Home", startDate: "2026-12-14", endDate: "2026-12-18" }],
			[COLLEGE_BREAKS[1]],
			[2026],
		);
		const spanOf = (id: string) => {
			const row = rows.find((candidate) => candidate.id === id);
			return row && `${row.source} ${row.startDate}..${row.endDate}`;
		};
		// A person's own Mon-to-Fri week reaches both weekends; the college's spring break does the
		// same; and Christmas Day 2026, a Friday, does not move at all.
		expect(spanOf("u1")).toBe("user 2026-12-12..2026-12-20");
		expect(spanOf("c2:ana")).toBe("college 2027-03-13..2027-03-21");
		expect(spanOf("federal:2026-12-25:emp")).toBe("default 2026-12-25..2026-12-25");
	});

	it("fills in nothing, stretched or otherwise, when no years were asked for", () => {
		// #392's silence rule, re-checked with the weekend rule in place: the stretching happens in
		// the same function, and it must not be what wakes the fallback up.
		expect(mergeBreakRows(WORKER, [], [])).toEqual([]);
	});
});
