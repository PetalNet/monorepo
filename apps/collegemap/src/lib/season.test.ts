import { describe, expect, it } from "vitest";

import { breakName, deriveSeason } from "./season";

describe("the season a break belongs to", () => {
	it("lets the name beat the date", () => {
		// Each of these starts in a month the date rule would call something else, which is the
		// only way to tell the two rules apart.
		expect(deriveSeason("Fall Break", "2026-08-31")).toBe("autumn"); // August
		expect(deriveSeason("Spring Break", "2027-02-27")).toBe("spring"); // February
		expect(deriveSeason("Summer session break", "2027-05-30")).toBe("summer"); // May
		expect(deriveSeason("Winter Break", "2026-11-30")).toBe("winter"); // November
	});

	it("does not let a label's provenance steal its season", () => {
		// Every one of these is a real 2026-27 entry. Each names two or three seasons in its
		// parenthetical and means exactly one.
		expect(
			deriveSeason("Winter break (fall exams end to spring classes begin)", "2026-12-11"),
		).toBe("winter");
		expect(
			deriveSeason(
				"Winter break (derived: last day of fall exams through first day of spring classes)",
				"2026-12-15",
			),
		).toBe("winter");
		expect(
			deriveSeason(
				"Winter break (gap between fall exams ending and spring classes starting; WashU publishes no named 'winter break' entry)",
				"2026-12-17",
			),
		).toBe("winter");
		expect(
			deriveSeason("Winter break (fall semester close to spring classwork start)", "2026-12-19"),
		).toBe("winter");
		expect(
			deriveSeason(
				"Winter break (derived: last day of fall term through start of spring term)",
				"2026-12-20",
			),
		).toBe("winter");
		expect(deriveSeason("Spring student/faculty break (spring break)", "2027-03-08")).toBe(
			"spring",
		);
		expect(deriveSeason("Fall student/faculty break", "2026-10-12")).toBe("autumn");
	});

	it("falls back to the meteorological season when the name says nothing", () => {
		expect(deriveSeason("Labor Day (no classes)", "2026-09-07")).toBe("autumn");
		expect(deriveSeason("Veteran's Day Holiday", "2026-11-11")).toBe("autumn");
		expect(deriveSeason("Holiday Vacation", "2026-12-18")).toBe("winter");
		expect(deriveSeason("No Classes (MLK Day)", "2027-01-18")).toBe("winter");
		expect(deriveSeason("February break", "2027-02-13")).toBe("winter");
		expect(deriveSeason("Semester Break (college closed)", "2027-03-26")).toBe("spring");
		expect(deriveSeason("Memorial Day - Holiday", "2027-05-31")).toBe("spring");
		expect(deriveSeason("Road trip", "2027-07-04")).toBe("summer");
	});

	it("puts every month in exactly one meteorological season", () => {
		const byMonth = Array.from({ length: 12 }, (_, i) =>
			deriveSeason("unnamed", `2027-${String(i + 1).padStart(2, "0")}-15`),
		);
		expect(byMonth).toEqual([
			"winter",
			"winter",
			"spring",
			"spring",
			"spring",
			"summer",
			"summer",
			"summer",
			"autumn",
			"autumn",
			"autumn",
			"winter",
		]);
	});

	it("reads a name the group typed themselves", () => {
		expect(deriveSeason("Thanksgiving at Grandma's", "2026-11-25")).toBe("autumn");
		expect(deriveSeason("Christmas in Denver", "2026-12-23")).toBe("winter");
		expect(deriveSeason("Easter weekend", "2027-03-26")).toBe("spring");
	});
});

describe("the name a break goes by", () => {
	it("drops the provenance a published label trails behind it", () => {
		expect(breakName("Thanksgiving Break (no classes)")).toBe("Thanksgiving Break");
		expect(breakName("Winter break (fall exams end to spring classes begin)")).toBe("Winter break");
		expect(
			breakName(
				"Winter break (gap between fall exams ending and spring classes starting; WashU publishes no named 'winter break' entry)",
			),
		).toBe("Winter break");
		expect(breakName("Labor Day - Holiday")).toBe("Labor Day");
		expect(breakName("Otterbein: no classes")).toBe("Otterbein");
	});

	it("leaves a label that is already just a name alone", () => {
		expect(breakName("Fall break")).toBe("Fall break");
		expect(breakName("Martin Luther King, Jr. Day")).toBe("Martin Luther King, Jr. Day");
		expect(breakName("Winter Interim 2026-27")).toBe("Winter Interim 2026-27");
		expect(breakName("Cousin's wedding in Denver")).toBe("Cousin's wedding in Denver");
	});
});
