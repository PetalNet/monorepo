import { describe, expect, it } from "vitest";

import {
	buildMonthView,
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
