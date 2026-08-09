import { describe, expect, it } from "vitest";

import {
	addDays,
	dayCount,
	formatRange,
	formatShort,
	fromDay,
	isIsoDate,
	startOfMonth,
	startOfNextMonth,
	toDay,
	todayIso,
} from "./dates";

describe("isIsoDate", () => {
	it("accepts real dates", () => {
		expect(isIsoDate("2026-12-19")).toBe(true);
		expect(isIsoDate("2028-02-29")).toBe(true); // leap year
	});

	it("rejects impossible and malformed dates", () => {
		expect(isIsoDate("2026-02-30")).toBe(false);
		expect(isIsoDate("2027-02-29")).toBe(false); // not a leap year
		expect(isIsoDate("2026-13-01")).toBe(false);
		expect(isIsoDate("2026-00-10")).toBe(false);
		expect(isIsoDate("2026-1-1")).toBe(false);
		expect(isIsoDate("19 Dec 2026")).toBe(false);
		expect(isIsoDate("")).toBe(false);
		expect(isIsoDate(null)).toBe(false);
		expect(isIsoDate(20261219)).toBe(false);
	});
});

describe("toDay / fromDay", () => {
	it("anchors on the epoch", () => {
		expect(toDay("1970-01-01")).toBe(0);
		expect(fromDay(0)).toBe("1970-01-01");
	});

	it("round-trips every day across a four-year span including two leap years", () => {
		let day = toDay("2025-01-01");
		const last = toDay("2029-01-01");
		let count = 0;
		for (; day <= last; day++) {
			expect(toDay(fromDay(day))).toBe(day);
			count++;
		}
		// 2025 + 2026 + 2027 (365 each) + 2028 (366) + 1 = 1462
		expect(count).toBe(1462);
	});

	it("counts a New Year crossing correctly", () => {
		// Dec 31 2026 -> Jan 1 2027 is one day apart.
		expect(toDay("2027-01-01") - toDay("2026-12-31")).toBe(1);
		// Dec 19 2026 through Jan 10 2027, inclusive, is 23 days.
		expect(dayCount(toDay("2026-12-19"), toDay("2027-01-10"))).toBe(23);
	});

	it("counts a leap day", () => {
		expect(dayCount(toDay("2028-02-28"), toDay("2028-03-01"))).toBe(3);
		expect(dayCount(toDay("2026-02-28"), toDay("2026-03-01"))).toBe(2);
	});

	it("is unaffected by the process timezone", () => {
		const zones = ["UTC", "America/Los_Angeles", "Pacific/Kiritimati", "Asia/Kolkata"];
		const original = process.env.TZ;
		const ours: string[] = [];
		const naive: number[] = [];
		try {
			for (const tz of zones) {
				process.env.TZ = tz;
				ours.push(`${String(toDay("2026-12-19"))}|${fromDay(20806)}`);
				// Positive control: the wrong way to do this. If this does NOT vary
				// across zones then the TZ switch is not taking effect and the
				// assertion below proves nothing.
				naive.push(new Date("2026-12-19").getDate());
			}
		} finally {
			process.env.TZ = original;
		}
		expect(new Set(naive).size).toBeGreaterThan(1);
		expect(new Set(ours)).toEqual(new Set(["20806|2026-12-19"]));
	});
});

describe("addDays", () => {
	it("walks over a month end and a year end", () => {
		expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
		expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
		expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
		expect(addDays("2026-12-19", 22)).toBe("2027-01-10");
	});
});

describe("formatting", () => {
	it("renders the calendar day it was given", () => {
		expect(formatShort("2026-12-19")).toBe("Sat, Dec 19");
		expect(formatShort("2027-01-01")).toBe("Fri, Jan 1");
	});

	it("shows both years when a range crosses New Year", () => {
		expect(formatRange("2026-12-19", "2027-01-10", 2026)).toBe("Dec 19, 2026 to Jan 10, 2027");
	});

	it("drops the year within the reference year", () => {
		expect(formatRange("2026-11-25", "2026-11-29", 2026)).toBe("Wed, Nov 25 to Sun, Nov 29");
	});

	it("collapses a single-day range instead of repeating the date", () => {
		expect(formatRange("2026-11-25", "2026-11-25", 2026)).toBe("Wed, Nov 25");
		expect(formatRange("2027-01-03", "2027-01-03", 2026)).toBe("Jan 3, 2027");
	});

	it("does not mix weekday and year styles inside a future year", () => {
		expect(formatRange("2027-01-05", "2027-01-10", 2026)).toBe("Jan 5 to Jan 10, 2027");
	});
});

describe("month helpers", () => {
	it("finds month edges across a year boundary", () => {
		expect(startOfMonth("2026-12-19")).toBe("2026-12-01");
		expect(startOfNextMonth("2026-12-19")).toBe("2027-01-01");
		expect(startOfNextMonth("2026-01-31")).toBe("2026-02-01");
	});
});

describe("todayIso", () => {
	it("produces a valid ISO date for a named timezone", () => {
		expect(isIsoDate(todayIso("America/New_York"))).toBe(true);
	});
});
