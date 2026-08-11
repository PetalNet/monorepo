/**
 * Merging the kinds of break the calendar shows.
 *
 * A person is off for two independent reasons: dates they entered themselves, and their college's
 * academic calendar. Both belong on the grid, so this unions them rather than letting one stand in
 * for the other. Kept pure and separate from the load so the union itself is testable.
 *
 * There is now a third reason, and it is deliberately weaker than the other two. Someone whose
 * affiliation is a job or a unit has no published calendar to scrape, so the app falls back to the
 * US federal holidays. That fallback is not a statement that this person is off: duty, watch,
 * deployment, leave, shift work and per-unit training holidays are all personal, and a calendar
 * that confidently shows someone free while they are on watch is worse than one that shows nothing,
 * because people plan around it. So those rows carry `source: "default"` rather than being dressed
 * up as an institutional calendar, and any day the person has already spoken for drops them.
 *
 * This is also where a break that touches a weekend is stretched across it. That belongs here and
 * not on the way into the database: the stored rows have to keep matching the calendars they were
 * transcribed from, and the import upserts on the start date, so rewriting dates at import time
 * would add rows rather than update them. It reaches the two sources that are statements — a
 * person's own dates and a transcribed institutional calendar — and not the filled-in third; see
 * `assumedRows` for why that is the same decision rather than an exception to it.
 */

import { fromDay, toDay, weekdayOf } from "../dates";
import { federalHolidays } from "../federal-holidays";
import {
	ASSUMED_SOURCE,
	FEDERAL_HOLIDAY_KINDS,
	type BreakSource,
	type InstitutionKind,
} from "../institutions";

/** Weekday numbers as `weekdayOf` returns them: Sunday is 0. */
const SUNDAY = 0;
const MONDAY = 1;
const FRIDAY = 5;
const SATURDAY = 6;

/**
 * A break that touches a weekend is off for the whole of it.
 *
 * Colleges write the same real break down differently. For Thanksgiving 2026 some publish the end
 * as Sun Nov 29 and some as Fri Nov 27, and the second group's students are just as plainly not at
 * class on the Saturday. The other end works the same way: a break beginning Mon Sep 7 begins, for
 * anyone planning around it, on the Saturday. Taking the published dates literally makes the grid
 * claim half the group is back at school on a weekend, so the days when everyone is actually free
 * never light up.
 *
 * Both directions, in one pass, because a break can qualify at both ends at once:
 *
 * - Ends Friday or Saturday -> runs through the Sunday after it
 * - Starts Monday or Sunday -> runs back to the Saturday before it
 *
 * A single day is left exactly as it is, whichever weekday it lands on. The calendars are full of
 * one-day holidays — Labor Day, MLK Day, Veterans Day, Presidents' Day, Good Friday — and a day off
 * in the middle of an otherwise ordinary week says nothing about the weekend around it. Good Friday
 * is the case that makes the point: it is a Friday, and it is still just a day off.
 *
 * The arithmetic runs on day numbers rather than `Date`, so no timezone can move it: `new
 * Date('2026-11-27')` read back with local getters is Thursday evening anywhere west of Greenwich,
 * and a break would silently stop extending.
 */
function acrossTheWeekend(span: { startDate: string; endDate: string }): {
	startDate: string;
	endDate: string;
} {
	if (span.startDate === span.endDate) return { startDate: span.startDate, endDate: span.endDate };

	const start = toDay(span.startDate);
	const end = toDay(span.endDate);
	const startWeekday = weekdayOf(start);
	const endWeekday = weekdayOf(end);
	return {
		startDate:
			startWeekday === MONDAY
				? fromDay(start - 2)
				: startWeekday === SUNDAY
					? fromDay(start - 1)
					: span.startDate,
		endDate:
			endWeekday === FRIDAY
				? fromDay(end + 2)
				: endWeekday === SATURDAY
					? fromDay(end + 1)
					: span.endDate,
	};
}

/** What the calendar grid and the editor consume. */
export interface CalendarBreakRow {
	id: string;
	userId: string;
	label: string;
	startDate: string;
	endDate: string;
	/**
	 * Where the row came from, and how much it is worth. `user` rows are the person's own and are
	 * theirs to delete; `college` rows are a transcribed institutional calendar; `default` rows are
	 * the app's own guess and are a claim about nobody. See `BreakSource`.
	 */
	source: BreakSource;
}

interface Person {
	id: string;
	collegeId: string | null;
	/** What sort of place that is. Absent or null for a person with no affiliation at all. */
	institutionKind?: InstitutionKind | null;
}

interface UserBreak {
	id: string;
	userId: string;
	label: string;
	startDate: string;
	endDate: string;
}

interface CollegeBreak {
	id: string;
	collegeId: string;
	label: string;
	startDate: string;
	endDate: string;
}

export function mergeBreakRows(
	people: Person[],
	userBreaks: UserBreak[],
	collegeBreaks: CollegeBreak[],
	/**
	 * Calendar years to fill federal holidays in for. Empty by default, on purpose: this is the one
	 * argument that makes the function invent dates nobody entered, so a caller who says nothing gets
	 * nothing rather than a year's worth of assumed days off.
	 */
	holidayYears: readonly number[] = [],
): CalendarBreakRow[] {
	const byCollege = new Map<string, CollegeBreak[]>();
	for (const collegeBreak of collegeBreaks) {
		const list = byCollege.get(collegeBreak.collegeId);
		if (list) list.push(collegeBreak);
		else byCollege.set(collegeBreak.collegeId, [collegeBreak]);
	}

	// One institutional row becomes one row per person at that college, so the id has to carry the
	// person too — otherwise the same id appears many times in a list that is keyed by it.
	const institutional = people.flatMap((person) =>
		(person.collegeId ? (byCollege.get(person.collegeId) ?? []) : []).map((collegeBreak) => ({
			id: `${collegeBreak.id}:${person.id}`,
			userId: person.id,
			label: collegeBreak.label,
			...acrossTheWeekend(collegeBreak),
			source: "college" as const,
		})),
	);

	const own = userBreaks.map((userBreak) => ({
		id: userBreak.id,
		userId: userBreak.userId,
		label: userBreak.label,
		...acrossTheWeekend(userBreak),
		source: "user" as const,
	}));

	// `own` is passed already stretched, because a stretched row is what the grid shows: if a
	// person's break covers a day, the weaker guess for that day has nothing left to add. Widening
	// it can only ever drop more, never fewer — but see below for why it drops exactly the same ones.
	return [...own, ...institutional, ...assumedRows(people, own, holidayYears)];
}

/**
 * The fallback rows: the one place this app fills in days nobody told it about.
 *
 * Only for the kinds with no calendar to read — a job and a unit. A college has a real published
 * one, and `other` has asked for nothing to be assumed.
 *
 * Two things keep these honest. They are labelled `default`, so the grid can show them as the
 * guesses they are rather than mixing them in with transcribed dates. And the person's own entries
 * win: a federal holiday is a single day, so if the person has already said something about that
 * day the guess is dropped entirely instead of stacking a second, weaker row on top of a real one.
 *
 * These rows are not stretched across a weekend, and that is the weekend rule agreeing with itself
 * rather than an exception carved out of it. Two facts about `federalHolidays`, both pinned by
 * test:
 *
 * 1. Every row here is one day — `startDate` and `endDate` are the same holiday date — which is
 *    exactly the case `acrossTheWeekend` leaves alone. Routing these through it would return them
 *    unchanged, so the choice is between a no-op and not writing it; and a lone public holiday
 *    saying nothing about the weekend around it is the guard's own stated reason.
 * 2. No observed date ever lands on a Saturday or a Sunday: 5 U.S.C. 6103 moves one that would.
 *    Stretching a `user` row only ever adds Saturdays and Sundays, so it cannot swallow a holiday
 *    it did not already cover, and the precedence above decides the same way it did before.
 */
function assumedRows(
	people: Person[],
	own: CalendarBreakRow[],
	holidayYears: readonly number[],
): CalendarBreakRow[] {
	if (holidayYears.length === 0) return [];

	const eligible = people.filter(
		(person) => person.institutionKind != null && FEDERAL_HOLIDAY_KINDS.has(person.institutionKind),
	);
	if (eligible.length === 0) return [];

	const holidays = holidayYears.flatMap((year) => federalHolidays(year));

	const spokenFor = new Map<string, { start: number; end: number }[]>();
	for (const row of own) {
		const span = { start: toDay(row.startDate), end: toDay(row.endDate) };
		const list = spokenFor.get(row.userId);
		if (list) list.push(span);
		else spokenFor.set(row.userId, [span]);
	}

	return eligible.flatMap((person) => {
		const stated = spokenFor.get(person.id) ?? [];
		return holidays
			.filter((holiday) => {
				const day = toDay(holiday.date);
				return !stated.some((span) => span.start <= day && day <= span.end);
			})
			.map((holiday) => ({
				// Same reason the institutional ids carry the person: one holiday becomes one row per
				// person, and the list is keyed by id.
				id: `federal:${holiday.date}:${person.id}`,
				userId: person.id,
				label: holiday.label,
				startDate: holiday.date,
				endDate: holiday.date,
				source: ASSUMED_SOURCE,
			}));
	});
}
