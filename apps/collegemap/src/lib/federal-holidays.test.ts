import { afterEach, describe, expect, it } from "vitest";

import { federalHolidays } from "./federal-holidays";

/** The observed date of one named holiday, by the name the statute gives it. */
function dateOf(year: number, name: string): string {
	const match = federalHolidays(year).find((holiday) => holiday.label.startsWith(name));
	if (!match) throw new Error(`No holiday named ${name} in ${String(year)}`);
	return match.date;
}

function labelOf(year: number, name: string): string {
	const match = federalHolidays(year).find((holiday) => holiday.label.startsWith(name));
	if (!match) throw new Error(`No holiday named ${name} in ${String(year)}`);
	return match.label;
}

describe("the eleven federal holidays", () => {
	it("is eleven of them, every year, named once each", () => {
		for (const year of [2021, 2022, 2023, 2026, 2027, 2028, 2029]) {
			const holidays = federalHolidays(year);
			expect(holidays, `count for ${String(year)}`).toHaveLength(11);
			expect(new Set(holidays.map((h) => h.label)).size, `names for ${String(year)}`).toBe(11);
			expect(new Set(holidays.map((h) => h.date)).size, `dates for ${String(year)}`).toBe(11);
		}
	});

	// The two years this app currently spans, pinned whole. Cross-checked against OPM's published
	// federal-holiday tables, not against this module.
	it("gives 2026 exactly", () => {
		expect(federalHolidays(2026)).toEqual([
			{ label: "New Year's Day", date: "2026-01-01" },
			{ label: "Birthday of Martin Luther King, Jr.", date: "2026-01-19" },
			{ label: "Washington's Birthday", date: "2026-02-16" },
			{ label: "Memorial Day", date: "2026-05-25" },
			{ label: "Juneteenth National Independence Day", date: "2026-06-19" },
			{ label: "Independence Day (observed)", date: "2026-07-03" },
			{ label: "Labor Day", date: "2026-09-07" },
			{ label: "Columbus Day", date: "2026-10-12" },
			{ label: "Veterans Day", date: "2026-11-11" },
			{ label: "Thanksgiving Day", date: "2026-11-26" },
			{ label: "Christmas Day", date: "2026-12-25" },
		]);
	});

	it("gives 2027 exactly", () => {
		expect(federalHolidays(2027)).toEqual([
			{ label: "New Year's Day", date: "2027-01-01" },
			{ label: "Birthday of Martin Luther King, Jr.", date: "2027-01-18" },
			{ label: "Washington's Birthday", date: "2027-02-15" },
			{ label: "Memorial Day", date: "2027-05-31" },
			{ label: "Juneteenth National Independence Day (observed)", date: "2027-06-18" },
			{ label: "Independence Day (observed)", date: "2027-07-05" },
			{ label: "Labor Day", date: "2027-09-06" },
			{ label: "Columbus Day", date: "2027-10-11" },
			{ label: "Veterans Day", date: "2027-11-11" },
			{ label: "Thanksgiving Day", date: "2027-11-25" },
			{ label: "Christmas Day (observed)", date: "2027-12-24" },
		]);
	});
});

describe("the floating holidays land on the right week", () => {
	// Third Monday, second Monday, first Monday and fourth Thursday are four different rules, and
	// an off-by-one in the shared arithmetic moves all of them by exactly seven days.
	it("puts MLK Day on the third Monday in January", () => {
		expect(dateOf(2026, "Birthday of Martin")).toBe("2026-01-19"); // Jan 2026 starts Thursday
		expect(dateOf(2027, "Birthday of Martin")).toBe("2027-01-18"); // Jan 2027 starts Friday
		expect(dateOf(2029, "Birthday of Martin")).toBe("2029-01-15"); // Jan 2029 starts ON a Monday
	});

	it("puts Washington's Birthday on the third Monday in February", () => {
		expect(dateOf(2026, "Washington")).toBe("2026-02-16");
		expect(dateOf(2028, "Washington")).toBe("2028-02-21"); // a leap February
	});

	it("puts Labor Day on the first Monday in September and Columbus Day on the second in October", () => {
		expect(dateOf(2026, "Labor")).toBe("2026-09-07");
		expect(dateOf(2029, "Labor")).toBe("2029-09-03");
		expect(dateOf(2026, "Columbus")).toBe("2026-10-12");
		expect(dateOf(2029, "Columbus")).toBe("2029-10-08");
	});

	it("puts Thanksgiving on the fourth Thursday in November, not the last one", () => {
		// November 2029 has five Thursdays; the fourth is the 22nd and the last is the 29th.
		expect(dateOf(2029, "Thanksgiving")).toBe("2029-11-22");
		expect(dateOf(2026, "Thanksgiving")).toBe("2026-11-26");
	});

	it("puts Memorial Day on the last Monday in May, which is not always the fourth", () => {
		// The pair that separates "last" from "fourth": May 2027 has five Mondays and May 2026 four.
		expect(dateOf(2027, "Memorial")).toBe("2027-05-31");
		expect(dateOf(2026, "Memorial")).toBe("2026-05-25");
	});

	it("never marks a floating holiday observed, since none can land on a weekend", () => {
		for (const year of [2021, 2022, 2023, 2026, 2027, 2028, 2029]) {
			for (const name of ["Birthday of Martin", "Washington", "Memorial", "Labor", "Columbus"]) {
				expect(labelOf(year, name), `${name} ${String(year)}`).not.toContain("(observed)");
			}
		}
	});
});

describe("a holiday on a weekend is observed on a weekday", () => {
	it("moves a Saturday holiday back to the Friday before", () => {
		// 2026-07-04 is a Saturday.
		expect(dateOf(2026, "Independence")).toBe("2026-07-03");
		expect(labelOf(2026, "Independence")).toBe("Independence Day (observed)");
		// 2027-12-25 is a Saturday.
		expect(dateOf(2027, "Christmas")).toBe("2027-12-24");
	});

	it("moves a Sunday holiday forward to the Monday after", () => {
		// 2027-07-04 is a Sunday.
		expect(dateOf(2027, "Independence")).toBe("2027-07-05");
		expect(labelOf(2027, "Independence")).toBe("Independence Day (observed)");
		// 2029-11-11 is a Sunday.
		expect(dateOf(2029, "Veterans")).toBe("2029-11-12");
	});

	it("observes a Saturday New Year's Day in the previous year", () => {
		// 2022-01-01 was a Saturday, so the federal day off was Friday 2021-12-31. The holiday still
		// belongs to 2022; only the date it is taken on falls outside it.
		expect(dateOf(2022, "New Year")).toBe("2021-12-31");
		expect(labelOf(2022, "New Year")).toBe("New Year's Day (observed)");
		// The mirror: 2023-01-01 was a Sunday, so the day off was Monday 2023-01-02.
		expect(dateOf(2023, "New Year")).toBe("2023-01-02");
	});

	it("leaves a weekday holiday exactly where it is", () => {
		// The control for every assertion above. Shifting unconditionally would satisfy them all and
		// would still be wrong: 2026 has one fixed-date holiday on a weekend and three that are not.
		for (const [name, date] of [
			["New Year", "2026-01-01"], // Thursday
			["Juneteenth", "2026-06-19"], // Friday
			["Veterans", "2026-11-11"], // Wednesday
			["Christmas", "2026-12-25"], // Friday
		]) {
			expect(dateOf(2026, name), name).toBe(date);
			expect(labelOf(2026, name), name).not.toContain("(observed)");
		}
	});
});

describe("the weekend rule is arithmetic no timezone can move", () => {
	const originalTz = process.env.TZ;

	afterEach(() => {
		if (originalTz === undefined) delete process.env.TZ;
		else process.env.TZ = originalTz;
	});

	it("still sees Saturday from a timezone behind UTC", () => {
		// `new Date('2026-07-04')` read with local getters is Friday evening in Los Angeles, so an
		// implementation using them would never shift Independence Day 2026 at all.
		process.env.TZ = "America/Los_Angeles";
		expect(dateOf(2026, "Independence")).toBe("2026-07-03");
		expect(dateOf(2026, "Thanksgiving")).toBe("2026-11-26");
	});

	it("does not invent a weekend from a timezone ahead of UTC", () => {
		// The mirror failure: local getters east of the line read 2026-12-25 as the 26th, a Saturday,
		// and would move Christmas off a Friday it belongs on.
		process.env.TZ = "Pacific/Kiritimati";
		expect(dateOf(2026, "Christmas")).toBe("2026-12-25");
		expect(labelOf(2026, "Christmas")).toBe("Christmas Day");
	});
});
