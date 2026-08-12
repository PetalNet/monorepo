import { describe, expect, it } from "vitest";

import {
	assumedFreeIds,
	buildMonthView,
	distinctReasons,
	pickInitialMonth,
	shiftMonth,
	toParticipants,
	WEEKDAY_LABELS,
} from "./calendar";
import { toDay } from "./dates";
import type { Participant } from "./overlap";

const r = (start: string, end: string) => ({ start: toDay(start), end: toDay(end) });
const cells = (view: ReturnType<typeof buildMonthView>) => view.weeks.flat();
const cell = (view: ReturnType<typeof buildMonthView>, iso: string) => {
	const found = cells(view).find((c) => c.iso === iso);
	if (!found) throw new Error(`no cell for ${iso}`);
	return found;
};

/**
 * The weekday of a calendar date, worked out without the module under test.
 *
 * `Date` is safe here only because the string is pinned to UTC midnight and read back through
 * `getUTCDay`. This is the independent oracle the grid gets checked against, so it deliberately
 * shares no arithmetic with it.
 */
function utcWeekday(iso: string): number {
	return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

/**
 * The column the month grid files a date under.
 *
 * Every row runs Sunday to Saturday, so a cell's index inside its week is the weekday the calendar
 * believes it to be. That column is where the module's weekday arithmetic becomes something a
 * person can see, which makes it the place to assert on it.
 */
function gridColumn(iso: string): number {
	for (const week of buildMonthView([], iso).weeks) {
		const column = week.findIndex((c) => c.iso === iso);
		if (column !== -1) return column;
	}
	throw new Error(`${iso} is missing from its own month grid`);
}

describe("the weekday a date lands on", () => {
	it("anchors on the epoch, which was a Thursday", () => {
		expect(WEEKDAY_LABELS[gridColumn("1970-01-01")]).toBe("Thu");
	});

	it("agrees with the calendar on real dates", () => {
		expect(WEEKDAY_LABELS[gridColumn("2026-12-01")]).toBe("Tue");
		expect(WEEKDAY_LABELS[gridColumn("2026-12-25")]).toBe("Fri");
		expect(WEEKDAY_LABELS[gridColumn("2027-01-01")]).toBe("Fri");
		expect(WEEKDAY_LABELS[gridColumn("2028-02-29")]).toBe("Tue");
	});

	it("files every cell of a month under its real weekday", () => {
		for (const week of buildMonthView([], "2026-12-01").weeks) {
			for (const [column, dayCell] of week.entries()) {
				expect(column).toBe(utcWeekday(dayCell.iso));
				expect(dayCell.isWeekend).toBe(column === 0 || column === 6);
			}
		}
	});
});

describe("buildMonthView grid shape", () => {
	const view = buildMonthView([], "2026-12-01");

	it("starts on a Sunday and ends on a Saturday", () => {
		const flat = cells(view);
		expect(WEEKDAY_LABELS[utcWeekday(flat[0].iso)]).toBe("Sun");
		expect(WEEKDAY_LABELS[utcWeekday(flat[flat.length - 1].iso)]).toBe("Sat");
	});

	it("pads with the neighbouring months so every row has seven cells", () => {
		expect(view.weeks.every((w) => w.length === 7)).toBe(true);
		expect(cells(view)).toHaveLength(35);
		expect(cells(view)[0].iso).toBe("2026-11-29");
		expect(cells(view)[34].iso).toBe("2027-01-02");
	});

	it("flags padding days as out of month and keeps all 31 real days", () => {
		expect(cells(view).filter((c) => c.inMonth)).toHaveLength(31);
		expect(cell(view, "2026-11-30").inMonth).toBe(false);
		expect(cell(view, "2027-01-01").inMonth).toBe(false);
		expect(cell(view, "2026-12-01").inMonth).toBe(true);
	});

	it("accepts any date inside the month, not just the first", () => {
		const mid = buildMonthView([], "2026-12-19");
		expect(mid.monthIso).toBe("2026-12-01");
		expect(mid.label).toBe("December 2026");
	});

	it("gets February right in a leap year and a common year", () => {
		expect(cells(buildMonthView([], "2028-02-01")).filter((c) => c.inMonth)).toHaveLength(29);
		expect(cells(buildMonthView([], "2027-02-01")).filter((c) => c.inMonth)).toHaveLength(28);
	});

	it("marks today, and only today", () => {
		const v = buildMonthView([], "2026-12-01", { todayIso: "2026-12-19" });
		expect(
			cells(v)
				.filter((c) => c.isToday)
				.map((c) => c.iso),
		).toEqual(["2026-12-19"]);
	});
});

describe("who is free on a day", () => {
	const two: Participant[] = [
		{ id: "a", ranges: [r("2026-12-19", "2027-01-04")] },
		{ id: "b", ranges: [r("2026-12-24", "2026-12-26")] },
	];

	it("puts a person on every day of their break and no others", () => {
		const v = buildMonthView(two, "2026-12-01");
		expect(cell(v, "2026-12-18").freeIds).toEqual([]);
		expect(cell(v, "2026-12-19").freeIds).toEqual(["a"]);
		expect(cell(v, "2026-12-24").freeIds).toEqual(["a", "b"]);
		expect(cell(v, "2026-12-26").freeIds).toEqual(["a", "b"]);
		expect(cell(v, "2026-12-27").freeIds).toEqual(["a"]);
	});

	it("marks all-free only on the days everyone is actually off", () => {
		const v = buildMonthView(two, "2026-12-01");
		expect(
			cells(v)
				.filter((c) => c.allFree)
				.map((c) => c.iso),
		).toEqual(["2026-12-24", "2026-12-25", "2026-12-26"]);
		expect(v.allFreeDays).toBe(3);
	});

	it("renders a single-day break as exactly one day", () => {
		const v = buildMonthView(
			[
				{ id: "a", ranges: [r("2026-12-25", "2026-12-25")] },
				{ id: "b", ranges: [r("2026-12-25", "2026-12-25")] },
			],
			"2026-12-01",
		);
		expect(
			cells(v)
				.filter((c) => c.freeCount > 0)
				.map((c) => c.iso),
		).toEqual(["2026-12-25"]);
		expect(cell(v, "2026-12-25").allFree).toBe(true);
	});

	it("carries a New Year crossing across both month views without dropping a day", () => {
		const nye: Participant[] = [
			{ id: "a", ranges: [r("2026-12-30", "2027-01-02")] },
			{ id: "b", ranges: [r("2026-12-30", "2027-01-02")] },
		];
		const dec = buildMonthView(nye, "2026-12-01");
		const jan = buildMonthView(nye, "2027-01-01");
		expect(cell(dec, "2026-12-31").allFree).toBe(true);
		expect(cell(jan, "2027-01-01").allFree).toBe(true);
		expect(cell(jan, "2027-01-02").allFree).toBe(true);
		expect(cell(jan, "2027-01-03").allFree).toBe(false);
		// December's own view sees Jan 1 as padding, and must agree about it.
		expect(cell(dec, "2027-01-01").allFree).toBe(true);
		expect(cell(dec, "2027-01-01").inMonth).toBe(false);
	});

	it("excludes people who have entered nothing from the denominator", () => {
		const withSilent: Participant[] = [...two, { id: "quiet", ranges: [] }];
		const v = buildMonthView(withSilent, "2026-12-01");
		expect(v.countedIds).toEqual(["a", "b"]);
		expect(cell(v, "2026-12-25").allFree).toBe(true);
	});

	it('never calls one lone person "everyone"', () => {
		const solo = buildMonthView(
			[{ id: "a", ranges: [r("2026-12-19", "2026-12-28")] }],
			"2026-12-01",
		);
		expect(solo.allFreeDays).toBe(0);
		expect(cell(solo, "2026-12-20").freeCount).toBe(1);
		expect(cell(solo, "2026-12-20").allFree).toBe(false);
	});

	it("reports nothing at all when nobody has entered anything", () => {
		const empty = buildMonthView([{ id: "a", ranges: [] }], "2026-12-01");
		expect(empty.countedIds).toEqual([]);
		expect(empty.allFreeDays).toBe(0);
		expect(cells(empty).every((c) => c.freeCount === 0)).toBe(true);
	});

	it("merges one person's touching breaks so the gap day is not a false negative", () => {
		const v = buildMonthView(
			[
				{ id: "a", ranges: [r("2026-12-19", "2026-12-24"), r("2026-12-25", "2026-12-31")] },
				{ id: "b", ranges: [r("2026-12-19", "2026-12-31")] },
			],
			"2026-12-01",
		);
		expect(cell(v, "2026-12-24").allFree).toBe(true);
		expect(cell(v, "2026-12-25").allFree).toBe(true);
	});

	it("is not moved by the process timezone", () => {
		const people: Participant[] = [
			{ id: "a", ranges: [r("2026-12-19", "2026-12-19")] },
			{ id: "b", ranges: [r("2026-12-19", "2026-12-19")] },
		];
		const original = process.env.TZ;
		const seen: string[] = [];
		const naive: number[] = [];
		try {
			for (const tz of ["UTC", "America/Los_Angeles", "Pacific/Kiritimati", "Asia/Kolkata"]) {
				process.env.TZ = tz;
				const v = buildMonthView(people, "2026-12-01", { todayIso: "2026-12-19" });
				seen.push(
					cells(v)
						.filter((c) => c.allFree)
						.map((c) => c.iso)
						.join(","),
				);
				// Positive control: if this does not vary, the TZ switch is inert and
				// the assertion below would pass for the wrong reason.
				naive.push(new Date("2026-12-19").getDate());
			}
		} finally {
			process.env.TZ = original;
		}
		expect(new Set(naive).size).toBeGreaterThan(1);
		expect(new Set(seen)).toEqual(new Set(["2026-12-19"]));
	});
});

describe("shiftMonth", () => {
	it("walks forward and backward over year boundaries", () => {
		expect(shiftMonth("2026-12-01", 1)).toBe("2027-01-01");
		expect(shiftMonth("2027-01-01", -1)).toBe("2026-12-01");
		expect(shiftMonth("2026-08-01", 5)).toBe("2027-01-01");
		expect(shiftMonth("2026-01-01", -1)).toBe("2025-12-01");
		expect(shiftMonth("2026-06-01", 0)).toBe("2026-06-01");
	});
});

describe("pickInitialMonth", () => {
	const winter: Participant[] = [
		{ id: "a", ranges: [r("2026-12-19", "2027-01-10")] },
		{ id: "b", ranges: [r("2026-12-22", "2027-01-05")] },
	];

	it("opens on the month holding the next all-free stretch", () => {
		expect(pickInitialMonth(winter, "2026-08-08")).toBe("2026-12-01");
	});

	it("opens on the current month when the all-free stretch is already running", () => {
		expect(pickInitialMonth(winter, "2026-12-28")).toBe("2026-12-01");
	});

	it("falls back to the next unfinished break when nobody ever overlaps", () => {
		const noOverlap: Participant[] = [
			{ id: "a", ranges: [r("2026-10-05", "2026-10-09")] },
			{ id: "b", ranges: [r("2026-11-21", "2026-11-29")] },
		];
		expect(pickInitialMonth(noOverlap, "2026-08-08")).toBe("2026-10-01");
	});

	it("falls back to the most recent break when everything is in the past", () => {
		expect(pickInitialMonth(winter, "2027-06-01")).toBe("2026-12-19".slice(0, 7) + "-01");
	});

	it("uses today when nobody has entered anything", () => {
		expect(pickInitialMonth([{ id: "a", ranges: [] }], "2026-08-08")).toBe("2026-08-01");
		expect(pickInitialMonth([], "2026-08-08")).toBe("2026-08-01");
	});

	it("uses the single person's own break when only one has entered", () => {
		expect(
			pickInitialMonth([{ id: "a", ranges: [r("2026-11-21", "2026-11-29")] }], "2026-08-08"),
		).toBe("2026-11-01");
	});
});

describe("toParticipants", () => {
	it("groups stored break rows under their owner and keeps people order", () => {
		const people = [{ id: "a" }, { id: "b" }, { id: "c" }];
		const rows = [
			{ userId: "b", startDate: "2026-12-19", endDate: "2026-12-28" },
			{ userId: "a", startDate: "2026-11-25", endDate: "2026-11-29" },
			{ userId: "b", startDate: "2027-03-14", endDate: "2027-03-22" },
		];
		const parts = toParticipants(people, rows);
		expect(parts.map((p) => p.id)).toEqual(["a", "b", "c"]);
		expect(parts[0].ranges).toEqual([r("2026-11-25", "2026-11-29")]);
		expect(parts[1].ranges).toHaveLength(2);
		expect(parts[2].ranges).toEqual([]);
	});

	it("ignores break rows whose owner is not in the people list", () => {
		const parts = toParticipants(
			[{ id: "a" }],
			[{ userId: "ghost", startDate: "2026-12-19", endDate: "2026-12-28" }],
		);
		expect(parts).toEqual([{ id: "a", ranges: [] }]);
	});
});

describe("assumedFreeIds", () => {
	// One assumed row and one stated row on the same day, for two different people.
	const ROWS = [
		{ userId: "ana", startDate: "2026-07-03", endDate: "2026-07-03", source: "default" },
		{ userId: "ben", startDate: "2026-07-01", endDate: "2026-07-06", source: "user" },
		{ userId: "cass", startDate: "2026-07-03", endDate: "2026-07-03", source: "college" },
	];

	it("names the person whose only reason to be off is a filled-in default", () => {
		expect(assumedFreeIds(ROWS, "2026-07-03")).toEqual(["ana"]);
	});

	it("leaves out people whose day came from themselves or their college", () => {
		const named = assumedFreeIds(ROWS, "2026-07-03");
		expect(named).not.toContain("ben");
		expect(named).not.toContain("cass");
	});

	it("drops someone who holds both, because the stated reason is what they are shown by", () => {
		const both = [
			...ROWS,
			{ userId: "ana", startDate: "2026-07-01", endDate: "2026-07-04", source: "user" },
		];
		expect(assumedFreeIds(both, "2026-07-03")).toEqual([]);
	});

	it("names a person once however many defaults cover the day", () => {
		const twice = [
			...ROWS,
			{ userId: "ana", startDate: "2026-07-03", endDate: "2026-07-03", source: "default" },
		];
		expect(assumedFreeIds(twice, "2026-07-03")).toEqual(["ana"]);
	});

	it("returns nothing for a day nobody is off, and for no day at all", () => {
		// The positive control: an empty answer has to be reachable only when it is the true one.
		expect(assumedFreeIds(ROWS, "2026-07-08")).toEqual([]);
		expect(assumedFreeIds(ROWS, null)).toEqual([]);
	});
});

describe("why each person is off", () => {
	// Two people at two colleges, off together over Thanksgiving week for differently named
	// breaks, and one of them also away on a trip she entered herself.
	const people = [{ id: "a" }, { id: "b" }];
	const rows = [
		{
			userId: "a",
			label: "Thanksgiving break",
			startDate: "2026-11-23",
			endDate: "2026-11-29",
		},
		{ userId: "a", label: "Ski trip", startDate: "2026-11-27", endDate: "2026-11-30" },
		{
			userId: "b",
			label: "Thanksgiving Week Break",
			startDate: "2026-11-25",
			endDate: "2026-11-27",
		},
	];
	const view = buildMonthView(toParticipants(people, rows), "2026-11-01", { breaks: rows });

	it("names the break each person is off for, on the person", () => {
		expect(
			cell(view, "2026-11-23")
				.reasons.get("a")
				?.map((why) => why.label),
		).toEqual(["Thanksgiving break"]);
		expect(cell(view, "2026-11-23").reasons.get("b")).toBeUndefined();
	});

	it("keeps two people's different reasons for the same day apart", () => {
		const day = cell(view, "2026-11-25");
		expect(day.freeIds).toEqual(["a", "b"]);
		expect(day.reasons.get("a")?.map((why) => why.label)).toEqual(["Thanksgiving break"]);
		expect(day.reasons.get("b")?.map((why) => why.label)).toEqual(["Thanksgiving Week Break"]);
	});

	it("gives one person both of their overlapping reasons, earliest first", () => {
		expect(
			cell(view, "2026-11-27")
				.reasons.get("a")
				?.map((why) => why.label),
		).toEqual(["Thanksgiving break", "Ski trip"]);
	});

	it("collapses the day's reasons to the distinct names, in participant order", () => {
		expect(distinctReasons(cell(view, "2026-11-27")).map((why) => why.name)).toEqual([
			"Thanksgiving break",
			"Ski trip",
			"Thanksgiving Week Break",
		]);
		expect(distinctReasons(cell(view, "2026-11-22"))).toEqual([]);
	});

	it("counts one holiday spelled two ways as one name, and two wordings as two", () => {
		// Verbatim from the 2026-27 data: eleven colleges, one Labor Day, and no two of them
		// writing it down the same way.
		const labels = ["Labor Day (no classes)", "Labor Day Holiday", "Labor Day holiday"];
		const labor = ["a", "b", "c"].map((userId, i) => ({
			userId,
			label: labels[i],
			startDate: "2026-09-07",
			endDate: "2026-09-07",
		}));
		const day = cell(
			buildMonthView(toParticipants([{ id: "a" }, { id: "b" }, { id: "c" }], labor), "2026-09-01", {
				breaks: labor,
			}),
			"2026-09-07",
		);
		// Positive control: all three are off, so a shorter list is a collapse and not a loss.
		expect(day.freeIds).toEqual(["a", "b", "c"]);
		expect(distinctReasons(day).map((why) => why.name)).toEqual(["Labor Day", "Labor Day Holiday"]);
	});

	it("says nothing at all when the labelled rows are not supplied", () => {
		const bare = buildMonthView(toParticipants(people, rows), "2026-11-01");
		// Positive control: the grid itself is unchanged, so an empty reasons map is the reasons
		// being absent rather than the whole month being empty.
		expect(cell(bare, "2026-11-25").freeIds).toEqual(["a", "b"]);
		expect(cell(bare, "2026-11-25").reasons.size).toBe(0);
		expect(cell(bare, "2026-11-25").season).toBeNull();
	});

	it("tints a day by the season most of the group is in", () => {
		expect(cell(view, "2026-11-25").season).toBe("autumn");
		expect(cell(view, "2026-11-22").season).toBeNull();
	});

	it("keeps a winter break winter after the New Year, where the date alone would not", () => {
		const winterRows = [
			{ userId: "a", label: "Winter break", startDate: "2026-12-19", endDate: "2027-01-18" },
		];
		const jan = buildMonthView(toParticipants([{ id: "a" }], winterRows), "2027-01-01", {
			breaks: winterRows,
		});
		expect(cell(jan, "2027-01-11").reasons.get("a")?.[0]).toEqual({
			name: "Winter break",
			label: "Winter break",
			season: "winter",
		});
	});
});

describe("back at school versus still at school", () => {
	const people = [{ id: "a" }, { id: "b" }, { id: "c" }];
	// a is off through Sunday Jan 10; b came back on Jan 4 and c on New Year's Day.
	const rows = [
		{ userId: "a", label: "Winter break", startDate: "2026-12-12", endDate: "2027-01-10" },
		{ userId: "b", label: "Christmas Break", startDate: "2026-12-21", endDate: "2027-01-03" },
		{ userId: "c", label: "Winter Break", startDate: "2026-12-21", endDate: "2026-12-31" },
	];
	const view = buildMonthView(toParticipants(people, rows), "2027-01-01", { breaks: rows });

	it("counts someone as back only on the first day after their break", () => {
		expect(cell(view, "2027-01-03").returningIds).toEqual([]);
		expect(cell(view, "2027-01-04").returningIds).toEqual(["b"]);
		expect(cell(view, "2027-01-05").returningIds).toEqual([]);
	});

	it("says back for the person who just returned and nothing for the one still away", () => {
		const day = cell(view, "2027-01-04");
		expect(day.freeIds).toEqual(["a"]);
		expect(day.returningIds).toEqual(["b"]);
	});

	it("reads a Monday after a break that ended on the Sunday as back", () => {
		// 2027-01-10 is a Sunday and 2027-01-11 the Monday after it. This is the case the
		// weekend-extension change is meant to produce, and the rule has to survive it.
		expect(cell(view, "2027-01-10").freeIds).toEqual(["a"]);
		expect(cell(view, "2027-01-11").returningIds).toEqual(["a"]);
	});

	it("never calls someone back who has not been off at all", () => {
		const never = buildMonthView(toParticipants([{ id: "a" }, { id: "n" }], rows), "2027-01-01", {
			breaks: rows,
		});
		expect(never.countedIds).toEqual(["a"]);
		expect(cells(never).every((c) => !c.returningIds.includes("n"))).toBe(true);
	});

	it("gives a padding day the same answer as the month that owns it", () => {
		const dec = buildMonthView(toParticipants(people, rows), "2026-12-01", { breaks: rows });
		const jan = buildMonthView(toParticipants(people, rows), "2027-01-01", { breaks: rows });
		expect(cell(dec, "2027-01-01").inMonth).toBe(false);
		expect(cell(jan, "2027-01-01").inMonth).toBe(true);
		// Non-empty on both sides, so this is two views agreeing about a real return rather than
		// two views both finding nothing.
		expect(cell(dec, "2027-01-01").returningIds).toEqual(["c"]);
		expect(cell(jan, "2027-01-01").returningIds).toEqual(["c"]);
	});
});
