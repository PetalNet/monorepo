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
 */

import { toDay } from "../dates";
import { federalHolidays } from "../federal-holidays";
import {
	ASSUMED_SOURCE,
	FEDERAL_HOLIDAY_KINDS,
	type BreakSource,
	type InstitutionKind,
} from "../institutions";

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
			startDate: collegeBreak.startDate,
			endDate: collegeBreak.endDate,
			source: "college" as const,
		})),
	);

	const own = userBreaks.map((userBreak) => ({
		id: userBreak.id,
		userId: userBreak.userId,
		label: userBreak.label,
		startDate: userBreak.startDate,
		endDate: userBreak.endDate,
		source: "user" as const,
	}));

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
