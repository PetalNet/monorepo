import { describe, expect, it } from "vitest";

import { toDay } from "./dates";
import { buildReport, mergeRanges, type Participant } from "./overlap";

const r = (start: string, end: string) => ({ start: toDay(start), end: toDay(end) });

/** Readable shape for assertions: ['2026-12-19', '2027-01-10', 23, 'a b'] */
const shape = (w: { start: string; end: string; days: number; freeIds: string[] }) =>
	[w.start, w.end, w.days, w.freeIds.join(" ")] as const;

/**
 * Every window the report surfaces, back in calendar order.
 *
 * `buildReport` splits its windows into "everyone is free" and near misses, and sorts each list by
 * how good a window is. Underneath, the engine emits one flat run of non-overlapping windows in
 * date order; rejoining the two lists is how a test looks at that run through the public surface.
 * `almostLimit` is lifted because the default caps the UI, not the engine.
 */
const windowsOf = (people: Participant[]) => {
	const report = buildReport(people, { almostLimit: 1000 });
	return [...report.everyone, ...report.almost].toSorted((a, b) => a.startDay - b.startDay);
};

describe("mergeRanges", () => {
	it("merges overlapping ranges", () => {
		expect(mergeRanges([r("2026-12-19", "2026-12-28"), r("2026-12-24", "2027-01-04")])).toEqual([
			r("2026-12-19", "2027-01-04"),
		]);
	});

	it("merges ranges that only touch, because Dec 24 then Dec 25 is one stretch", () => {
		expect(mergeRanges([r("2026-12-19", "2026-12-24"), r("2026-12-25", "2026-12-31")])).toEqual([
			r("2026-12-19", "2026-12-31"),
		]);
	});

	it("keeps a one-day gap separate", () => {
		const input = [r("2026-12-19", "2026-12-24"), r("2026-12-26", "2026-12-31")];
		expect(mergeRanges(input)).toHaveLength(2);
	});

	it("swallows a range fully inside another", () => {
		expect(mergeRanges([r("2026-12-01", "2026-12-31"), r("2026-12-10", "2026-12-12")])).toEqual([
			r("2026-12-01", "2026-12-31"),
		]);
	});

	it("does not mutate its input", () => {
		const input = [r("2026-12-19", "2026-12-28"), r("2026-12-24", "2027-01-04")];
		const copy = structuredClone(input);
		mergeRanges(input);
		expect(input).toEqual(copy);
	});
});

describe("the free windows a report surfaces", () => {
	it("finds a plain two-person overlap and counts the days inclusively", () => {
		const people: Participant[] = [
			{ id: "a", ranges: [r("2026-12-12", "2027-01-04")] },
			{ id: "b", ranges: [r("2026-12-19", "2027-01-10")] },
		];
		const both = windowsOf(people).filter((w) => w.freeIds.length === 2);
		// Dec 19 through Jan 4 inclusive: 13 days in December (19..31) + 4 = 17.
		expect(both.map(shape)).toEqual([["2026-12-19", "2027-01-04", 17, "a b"]]);
	});

	it("returns nothing when two people never overlap", () => {
		const people: Participant[] = [
			{ id: "a", ranges: [r("2026-11-21", "2026-11-29")] },
			{ id: "b", ranges: [r("2026-12-19", "2027-01-10")] },
		];
		expect(windowsOf(people)).toEqual([]);
	});

	it("returns nothing when breaks are merely adjacent, not overlapping", () => {
		// a is back at school the day b leaves. Nobody is free together.
		const people: Participant[] = [
			{ id: "a", ranges: [r("2026-12-10", "2026-12-18")] },
			{ id: "b", ranges: [r("2026-12-19", "2027-01-10")] },
		];
		expect(windowsOf(people)).toEqual([]);
	});

	it("handles a single-day overlap", () => {
		const people: Participant[] = [
			{ id: "a", ranges: [r("2026-12-10", "2026-12-19")] },
			{ id: "b", ranges: [r("2026-12-19", "2027-01-10")] },
		];
		expect(windowsOf(people).map(shape)).toEqual([["2026-12-19", "2026-12-19", 1, "a b"]]);
	});

	it("handles a single-day break on both sides", () => {
		const people: Participant[] = [
			{ id: "a", ranges: [r("2026-10-13", "2026-10-13")] },
			{ id: "b", ranges: [r("2026-10-13", "2026-10-13")] },
		];
		expect(windowsOf(people).map(shape)).toEqual([["2026-10-13", "2026-10-13", 1, "a b"]]);
	});

	it("splits one long overlap into distinct windows as people come and go", () => {
		const people: Participant[] = [
			{ id: "a", ranges: [r("2026-12-15", "2027-01-15")] },
			{ id: "b", ranges: [r("2026-12-15", "2027-01-15")] },
			{ id: "c", ranges: [r("2026-12-20", "2026-12-30")] },
		];
		const windows = windowsOf(people);
		expect(windows.map(shape)).toEqual([
			["2026-12-15", "2026-12-19", 5, "a b"],
			["2026-12-20", "2026-12-30", 11, "a b c"],
			["2026-12-31", "2027-01-15", 16, "a b"],
		]);
		expect(windows[1].missingIds).toEqual([]);
		expect(windows[0].missingIds).toEqual(["c"]);
	});

	it("does not glue two same-set windows that have a gap between them", () => {
		const people: Participant[] = [
			{ id: "a", ranges: [r("2026-11-25", "2026-11-29"), r("2026-12-19", "2027-01-10")] },
			{ id: "b", ranges: [r("2026-11-25", "2026-11-29"), r("2026-12-19", "2027-01-10")] },
		];
		expect(windowsOf(people).map(shape)).toEqual([
			["2026-11-25", "2026-11-29", 5, "a b"],
			["2026-12-19", "2027-01-10", 23, "a b"],
		]);
	});

	it("spans a New Year without losing or gaining a day", () => {
		const people: Participant[] = [
			{ id: "a", ranges: [r("2026-12-19", "2027-01-10")] },
			{ id: "b", ranges: [r("2026-12-19", "2027-01-10")] },
		];
		const [w] = windowsOf(people);
		// December 19..31 is 13 days, January 1..10 is 10 days. 23 total.
		expect(w.days).toBe(23);
		expect([w.start, w.end]).toEqual(["2026-12-19", "2027-01-10"]);
	});

	it("ignores people with no breaks entered", () => {
		const people: Participant[] = [
			{ id: "a", ranges: [r("2026-12-19", "2027-01-10")] },
			{ id: "b", ranges: [r("2026-12-19", "2027-01-10")] },
			{ id: "quiet", ranges: [] },
		];
		const [w] = windowsOf(people);
		expect(w.freeIds).toEqual(["a", "b"]);
		expect(w.missingIds).toEqual([]);
	});

	it("returns nothing for a group of one, or a group of none", () => {
		expect(windowsOf([{ id: "a", ranges: [r("2026-12-19", "2027-01-10")] }])).toEqual([]);
		expect(windowsOf([])).toEqual([]);
		expect(
			windowsOf([
				{ id: "a", ranges: [] },
				{ id: "b", ranges: [] },
			]),
		).toEqual([]);
	});

	it("never emits an empty or backwards window", () => {
		const people: Participant[] = [
			{ id: "a", ranges: [r("2026-03-14", "2026-03-22"), r("2026-05-10", "2026-08-20")] },
			{ id: "b", ranges: [r("2026-03-07", "2026-03-15"), r("2026-05-01", "2026-08-25")] },
			{ id: "c", ranges: [r("2026-03-21", "2026-03-29"), r("2026-06-01", "2026-07-31")] },
		];
		for (const w of windowsOf(people)) {
			expect(w.endDay).toBeGreaterThanOrEqual(w.startDay);
			expect(w.days).toBe(w.endDay - w.startDay + 1);
			expect(w.freeIds.length + w.missingIds.length).toBe(3);
		}
	});

	it("never surfaces a window where somebody is free alone", () => {
		// Most of this season is one person off on their own, which is not an overlap and must
		// not reach the report. Only Dec 20, where a's break ends and b's begins, qualifies.
		const people: Participant[] = [
			{ id: "a", ranges: [r("2026-12-01", "2026-12-20")] },
			{ id: "b", ranges: [r("2026-12-20", "2027-01-15")] },
			{ id: "c", ranges: [r("2027-03-01", "2027-03-08")] },
		];
		const windows = windowsOf(people);
		expect(windows.map(shape)).toEqual([["2026-12-20", "2026-12-20", 1, "a b"]]);
		for (const w of windows) {
			expect(w.freeIds.length).toBeGreaterThanOrEqual(2);
		}
	});

	it("agrees with a brute-force day-by-day count", () => {
		const cast: Participant[] = [
			{ id: "a", ranges: [r("2026-11-25", "2026-11-29"), r("2026-12-18", "2027-01-11")] },
			{ id: "b", ranges: [r("2026-11-21", "2026-11-29"), r("2026-12-12", "2027-01-25")] },
			{ id: "c", ranges: [r("2026-11-26", "2026-11-28"), r("2026-12-19", "2027-01-04")] },
			{ id: "d", ranges: [r("2026-12-20", "2027-01-06")] },
		];

		// A near miss is capped at one person short of the group, or two once the group reaches
		// five, so a four-person report surfaces the 3-of-4 and 4-of-4 days and nothing thinner.
		// The brute-force side is held to the same floor. Running the three-person slice of the
		// same data straight afterwards puts that floor back down at two, so the pairs the wider
		// group hides are still checked somewhere.
		for (const [people, floor] of [
			[cast, 3],
			[cast.slice(0, 3), 2],
		] as const) {
			// Independent check: walk every day of the season and record who is free.
			const from = toDay("2026-11-01");
			const to = toDay("2027-02-28");
			const bruteByDay = new Map<number, string>();
			for (let d = from; d <= to; d++) {
				const free = people
					.filter((p) => p.ranges.some((rr) => d >= rr.start && d <= rr.end))
					.map((p) => p.id);
				if (free.length >= floor) bruteByDay.set(d, free.join(" "));
			}

			const engineByDay = new Map<number, string>();
			for (const w of windowsOf(people)) {
				for (let d = w.startDay; d <= w.endDay; d++) {
					expect(engineByDay.has(d)).toBe(false); // windows must not overlap
					engineByDay.set(d, w.freeIds.join(" "));
				}
			}

			expect(engineByDay.size).toBeGreaterThan(0); // positive control
			expect([...engineByDay.entries()].toSorted()).toEqual([...bruteByDay.entries()].toSorted());
		}
	});
});

describe("buildReport", () => {
	const seasoned: Participant[] = [
		{ id: "a", ranges: [r("2026-12-18", "2027-01-11")] },
		{ id: "b", ranges: [r("2026-12-12", "2027-01-25")] },
		{ id: "c", ranges: [r("2026-12-19", "2027-01-04")] },
	];

	it("ranks all-free windows longest first", () => {
		const report = buildReport(
			[
				{ id: "a", ranges: [r("2026-11-25", "2026-11-29"), r("2026-12-19", "2027-01-10")] },
				{ id: "b", ranges: [r("2026-11-25", "2026-11-29"), r("2026-12-19", "2027-01-10")] },
			],
			{ todayIso: "2026-11-01" },
		);
		expect(report.everyone.map((w) => w.days)).toEqual([23, 5]);
	});

	it("separates the silent from the counted", () => {
		const report = buildReport([...seasoned, { id: "quiet", ranges: [] }], {
			todayIso: "2026-11-01",
		});
		expect(report.counted).toEqual(["a", "b", "c"]);
		expect(report.silent).toEqual(["quiet"]);
		expect(report.everyone).toHaveLength(1);
		expect(shape(report.everyone[0])).toEqual(["2026-12-19", "2027-01-04", 17, "a b c"]);
	});

	it("reports near misses with who is missing", () => {
		const report = buildReport(seasoned, { todayIso: "2026-11-01" });
		expect(report.almost.length).toBeGreaterThan(0);
		for (const w of report.almost) {
			expect(w.freeIds.length).toBe(2);
			expect(w.missingIds).toHaveLength(1);
		}
		const best = report.almost[0];
		// Dec 12..18 is a + missing, actually b and a from Dec 18. Longest 2-of-3
		// stretch is Jan 5..11 (a and b, c already back) = 7 days.
		expect(best.days).toBe(7);
		expect(shape(best)).toEqual(["2027-01-05", "2027-01-11", 7, "a b"]);
	});

	it("drops windows that already finished", () => {
		const past = buildReport(seasoned, { todayIso: "2027-06-01" });
		expect(past.everyone).toEqual([]);
		expect(past.almost).toEqual([]);
		// Positive control: the same data before the cutoff does produce windows.
		expect(buildReport(seasoned, { todayIso: "2026-11-01" }).everyone.length).toBe(1);
	});

	it("keeps a window that is happening right now", () => {
		const now = buildReport(seasoned, { todayIso: "2026-12-28" });
		expect(now.everyone.map((w) => w.start)).toEqual(["2026-12-19"]);
	});

	it("handles a group where nobody has entered anything", () => {
		const report = buildReport([
			{ id: "a", ranges: [] },
			{ id: "b", ranges: [] },
		]);
		expect(report).toEqual({ counted: [], silent: ["a", "b"], everyone: [], almost: [] });
	});

	it("handles two people with zero overlap", () => {
		const report = buildReport(
			[
				{ id: "a", ranges: [r("2026-11-21", "2026-11-29")] },
				{ id: "b", ranges: [r("2026-12-19", "2027-01-10")] },
			],
			{ todayIso: "2026-11-01" },
		);
		expect(report.counted).toHaveLength(2);
		expect(report.everyone).toEqual([]);
		expect(report.almost).toEqual([]);
	});

	it("allows a two-away near miss once the group is five or more", () => {
		const five: Participant[] = ["a", "b", "c"].map((id) => ({
			id,
			ranges: [r("2026-12-19", "2027-01-04")],
		}));
		five.push({ id: "d", ranges: [r("2026-12-27", "2027-01-04")] });
		five.push({ id: "e", ranges: [r("2026-12-27", "2027-01-04")] });
		const report = buildReport(five, { todayIso: "2026-11-01" });
		expect(report.everyone.map(shape)).toEqual([["2026-12-27", "2027-01-04", 9, "a b c d e"]]);
		expect(report.almost.map(shape)).toEqual([["2026-12-19", "2026-12-26", 8, "a b c"]]);
	});
});
