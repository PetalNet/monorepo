/**
 * The eleven US federal holidays of 5 U.S.C. 6103, computed for any year.
 *
 * Computed and not tabulated. Six of the eleven float — "the third Monday in January" — and a
 * seventh moves whenever a fixed date lands on a weekend, so a table is a table for one year. This
 * app already spans 2026-27 and will roll over without anyone remembering to edit it.
 *
 * Every date here is a calendar day, never an instant, and all the arithmetic runs on the integer
 * day numbers of `$lib/dates`. `new Date('2026-07-04').getDay()` is Friday evening anywhere west of
 * Greenwich, which would silently shift the Saturday rule by a day and produce holidays nobody
 * has.
 */

import { fromDay, startOfNextMonth, toDay, weekdayOf } from "./dates";

/** Weekday numbers as `weekdayOf` returns them: Sunday is 0. */
const SUNDAY = 0;
const MONDAY = 1;
const THURSDAY = 4;
const SATURDAY = 6;

/** One day off. */
export interface FederalHoliday {
	/**
	 * The statutory name, with "(observed)" appended when the day off is not the holiday's own date.
	 * That suffix is the reader's only clue that Friday the 3rd is Independence Day, so it belongs in
	 * the label rather than in a flag some caller has to remember to render.
	 */
	label: string;
	/** The day actually taken off, `YYYY-MM-DD`. */
	date: string;
}

function iso(year: number, month1: number, day: number): string {
	return `${String(year).padStart(4, "0")}-${String(month1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The nth (1-based) given weekday of a month. */
function nthWeekday(year: number, month1: number, weekday: number, n: number): string {
	const first = toDay(iso(year, month1, 1));
	const offset = (weekday - weekdayOf(first) + 7) % 7;
	return fromDay(first + offset + (n - 1) * 7);
}

/**
 * The last given weekday of a month.
 *
 * Not a synonym for the fourth: May 2027 has five Mondays, and Memorial Day is the fifth.
 */
function lastWeekday(year: number, month1: number, weekday: number): string {
	const last = toDay(startOfNextMonth(iso(year, month1, 1))) - 1;
	return fromDay(last - ((weekdayOf(last) - weekday + 7) % 7));
}

/**
 * The weekend rule: 5 U.S.C. 6103(a), as implemented for the executive branch by EO 11582.
 *
 * A holiday falling on a Saturday is observed the Friday before it; one falling on a Sunday, the
 * Monday after. Only the five fixed-date holidays can trigger it — the floating ones are defined as
 * a Monday or a Thursday.
 *
 * The Friday case can leave the year entirely: New Year's Day 2022 was a Saturday, so the day off
 * was Friday 31 December 2021. `federalHolidays(2022)` therefore returns a date in 2021, on
 * purpose. It is the same holiday; it is just observed early.
 */
function observe(date: string): { date: string; moved: boolean } {
	const day = toDay(date);
	const weekday = weekdayOf(day);
	if (weekday === SATURDAY) return { date: fromDay(day - 1), moved: true };
	if (weekday === SUNDAY) return { date: fromDay(day + 1), moved: true };
	return { date, moved: false };
}

/** The eleven holidays as the statute defines them, before the weekend rule is applied. */
function statutory(year: number): { name: string; date: string }[] {
	return [
		{ name: "New Year's Day", date: iso(year, 1, 1) },
		{ name: "Birthday of Martin Luther King, Jr.", date: nthWeekday(year, 1, MONDAY, 3) },
		{ name: "Washington's Birthday", date: nthWeekday(year, 2, MONDAY, 3) },
		{ name: "Memorial Day", date: lastWeekday(year, 5, MONDAY) },
		{ name: "Juneteenth National Independence Day", date: iso(year, 6, 19) },
		{ name: "Independence Day", date: iso(year, 7, 4) },
		{ name: "Labor Day", date: nthWeekday(year, 9, MONDAY, 1) },
		{ name: "Columbus Day", date: nthWeekday(year, 10, MONDAY, 2) },
		{ name: "Veterans Day", date: iso(year, 11, 11) },
		{ name: "Thanksgiving Day", date: nthWeekday(year, 11, THURSDAY, 4) },
		{ name: "Christmas Day", date: iso(year, 12, 25) },
	];
}

/** The eleven federal holidays of one year, in statutory order, as they are actually observed. */
export function federalHolidays(year: number): FederalHoliday[] {
	return statutory(year).map((holiday) => {
		const { date, moved } = observe(holiday.date);
		return { label: moved ? `${holiday.name} (observed)` : holiday.name, date };
	});
}
