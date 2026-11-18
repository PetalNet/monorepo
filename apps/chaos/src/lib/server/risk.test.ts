import { expect, it } from "vitest";

import type { KevEntry } from "./kev";
import { risk } from "./risk";
import { openStore, type Store } from "./store";

const TODAY = "2026-11-18";
let serial = 0;

function entries(dateAdded: string, count: number): KevEntry[] {
	return Array.from({ length: count }, () => {
		serial += 1;

		return {
			cveId: `CVE-2026-${String(serial)}`,
			vendor: "Acme",
			product: "Widget",
			name: "",
			description: "",
			dateAdded,
			dueDate: "2026-12-09",
			ransomware: false,
		};
	});
}

function stored(rows: KevEntry[]): Store {
	const store = openStore(":memory:");

	store.save(rows, null, new Date(`${TODAY}T17:00:00Z`));

	return store;
}

/** One entry years back, so the list reaches past the baseline. */
const OLD = entries("2021-11-03", 1);

it("gives no reading when no pull has succeeded today", () => {
	expect(risk(stored(OLD), TODAY, "2026-11-17")).toMatchObject({ kind: "stale" });
});

it("says the history is short instead of inventing a baseline", () => {
	// 53 weeks are needed. A list that starts 100 days ago has no year to compare with.
	expect(risk(stored(entries("2026-08-11", 5)), TODAY, TODAY)).toEqual({
		baselineWeeks: 52,
		kind: "short",
		days: 100,
		needed: 371,
	});

	expect(risk(openStore(":memory:"), TODAY, "")).toMatchObject({ kind: "stale" });
});

it("starts reading on the first day the list covers 53 whole weeks", () => {
	expect(risk(stored(entries("2025-11-14", 1)), TODAY, TODAY).kind).toBe("short");
	expect(risk(stored(entries("2025-11-13", 1)), TODAY, TODAY).kind).toBe("reading");
});

it("counts the seven days ending today against the 52 weeks before them", () => {
	const reading = risk(
		stored([
			...OLD,
			// This week: November 12 to 18.
			...entries("2026-11-12", 2),
			...entries("2026-11-18", 1),
			// The week before, November 5 to 11, and one a year back.
			...entries("2026-11-11", 5),
			...entries("2025-11-20", 2),
			// The day before the baseline starts must not count.
			...entries("2025-11-12", 9),
		]),
		TODAY,
		TODAY,
	);

	expect(reading).toMatchObject({ kind: "reading", week: 3, quieterWeeks: 51, median: 0 });

	if (reading.kind === "reading") {
		expect(reading.weeks).toHaveLength(53);
		expect(reading.weeks[0]).toEqual({ end: "2025-11-19", added: 0 });
		expect(reading.weeks[1]).toEqual({ end: "2025-11-26", added: 2 });
		expect(reading.weeks.at(-2)).toEqual({ end: "2026-11-11", added: 5 });
		expect(reading.weeks.at(-1)).toEqual({ end: TODAY, added: 3 });
	}
});

it("labels the week from how many baseline weeks were quieter", () => {
	const weekEnding = (week: number) => {
		const day = new Date(`${TODAY}T12:00:00Z`);

		day.setUTCDate(day.getUTCDate() - 7 * week);

		return day.toISOString().slice(0, 10);
	};

	/** A year in which `quieter` weeks had 2 additions and the rest had 6, read in a week with 4. */
	const level = (quieter: number) => {
		const baseline = Array.from({ length: 52 }, (_, index) =>
			entries(weekEnding(index + 1), index < quieter ? 2 : 6),
		).flat();
		const reading = risk(stored([...OLD, ...baseline, ...entries(TODAY, 4)]), TODAY, TODAY);

		return reading.kind === "reading" ? [reading.quieterWeeks, reading.level] : [];
	};

	expect(level(0)).toEqual([0, "quiet"]);
	expect(level(25)).toEqual([25, "quiet"]);
	expect(level(26)).toEqual([26, "busy"]);
	expect(level(46)).toEqual([46, "busy"]);
	expect(level(47)).toEqual([47, "heavy"]);
	expect(level(52)).toEqual([52, "heavy"]);
});

it("does not count a week with the same additions as quieter, and takes the median of the year", () => {
	const reading = risk(
		stored([
			...OLD,
			...entries("2026-11-11", 3),
			...entries("2026-11-04", 9),
			...entries(TODAY, 3),
		]),
		TODAY,
		TODAY,
	);

	expect(reading).toMatchObject({ week: 3, quieterWeeks: 50, median: 0 });
});
