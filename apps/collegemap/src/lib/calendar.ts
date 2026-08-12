/**
 * The month-grid layer on top of the overlap engine.
 *
 * `overlap.ts` answers "which stretches of calendar is the group free?". A calendar asks the
 * transposed question: "for this one square, who is off?". This module does that transpose, and
 * nothing else. All arithmetic stays in integer day numbers so a timezone can never move a break by
 * a day.
 */

import { fromDay, startOfMonth, startOfNextMonth, toDay, weekdayOf } from "./dates";
import { ASSUMED_SOURCE } from "./institutions";
import { mergeRanges, type DayRange, type Participant } from "./overlap";
import { breakName, deriveSeason, type Season } from "./season";

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** One named reason a person is off. */
export interface DayReason {
	/** What the break is called: the label with its trailing provenance dropped. */
	name: string;
	/** The label exactly as entered or published, for a tooltip. */
	label: string;
	season: Season;
}

export interface DayCell {
	iso: string;
	dayOfMonth: number;
	/** False for the leading/trailing padding days of the grid. */
	inMonth: boolean;
	isToday: boolean;
	isWeekend: boolean;
	/** Ids of everyone off on this day, in participant order. */
	freeIds: string[];
	freeCount: number;
	/** Every counted participant is off, and there are at least two of them. */
	allFree: boolean;
	/**
	 * Why each free person is off, keyed by their id, earliest break first.
	 *
	 * Keyed by person rather than grouped by break on purpose: two people can be off on the same day
	 * for entirely different reasons, and one of them can be off for two at once. A person is the
	 * thing that appears exactly once.
	 */
	reasons: ReadonlyMap<string, DayReason[]>;
	/**
	 * Counted people who are at school today but were off yesterday: the ones who have just come
	 * back, rather than the ones who never left.
	 */
	returningIds: string[];
	/** The prevailing season of the day's named breaks, or null when nothing named covers it. */
	season: Season | null;
}

export interface MonthView {
	/** `YYYY-MM-01`. */
	monthIso: string;
	year: number;
	/** 1-12. */
	month: number;
	label: string;
	weeks: DayCell[][];
	/** Participants who have entered at least one break: the denominator. */
	countedIds: string[];
	/** Days inside this month where everyone is free. */
	allFreeDays: number;
}

const MONTH_NAMES = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

/** Two-digit zero-padded month or day, for building `YYYY-MM-DD` strings. */
function pad(n: number): string {
	return String(n).padStart(2, "0");
}

/** `YYYY-MM-01` for a 1-12 month of a year. */
function firstOfMonth(year: number, month1: number): string {
	return `${String(year)}-${pad(month1)}-01`;
}

/** `YYYY-MM-01` for the month containing a day number. */
function monthOf(day: number): string {
	return startOfMonth(fromDay(day));
}

function daysInMonth(year: number, month1: number): number {
	// Day number of the 1st of next month, minus day number of the 1st of this.
	const first = firstOfMonth(year, month1);
	return toDay(startOfNextMonth(first)) - toDay(first);
}

function covers(ranges: DayRange[], day: number): boolean {
	for (const r of ranges) {
		if (day < r.start) return false;
		if (day <= r.end) return true;
	}
	return false;
}

/** A stored break with the name it was entered or published under. */
export interface LabeledBreak {
	userId: string;
	label: string;
	startDate: string;
	endDate: string;
}

interface NamedRange extends DayRange, DayReason {}

export interface MonthOptions {
	/** `YYYY-MM-DD`; the day to mark as today. Omit to mark none. */
	todayIso?: string;
	/**
	 * The named breaks behind the participants' ranges. Supply them and every cell can say _why_ each
	 * person is off; omit them and the grid is unchanged, it just cannot name a reason.
	 */
	breaks?: readonly LabeledBreak[];
}

/** The named breaks per person, sorted so a day's reasons come out in a stable order. */
function namedRangesByPerson(rows: readonly LabeledBreak[]): Map<string, NamedRange[]> {
	const byUser = new Map<string, NamedRange[]>();
	for (const row of rows) {
		const range: NamedRange = {
			start: toDay(row.startDate),
			end: toDay(row.endDate),
			name: breakName(row.label),
			label: row.label,
			season: deriveSeason(row.label, row.startDate),
		};
		const list = byUser.get(row.userId);
		if (list) list.push(range);
		else byUser.set(row.userId, [range]);
	}
	for (const [id, list] of byUser) {
		byUser.set(
			id,
			list.toSorted((a, b) => a.start - b.start || a.label.localeCompare(b.label)),
		);
	}
	return byUser;
}

/**
 * Build one month of the calendar.
 *
 * `monthIso` may be any date inside the wanted month. The grid always starts on a Sunday and ends
 * on a Saturday, padded with the neighbouring months' days so every row has seven cells.
 */
export function buildMonthView(
	participants: Participant[],
	monthIso: string,
	options: MonthOptions = {},
): MonthView {
	const year = Number(monthIso.slice(0, 4));
	const month = Number(monthIso.slice(5, 7));
	const firstIso = firstOfMonth(year, month);

	const active = participants
		.map((p) => ({ id: p.id, ranges: mergeRanges(p.ranges) }))
		.filter((p) => p.ranges.length > 0);
	const countedIds = active.map((p) => p.id);
	const named = namedRangesByPerson(options.breaks ?? []);

	const firstDay = toDay(firstIso);
	const length = daysInMonth(year, month);
	const lastDay = firstDay + length - 1;

	const gridStart = firstDay - weekdayOf(firstDay);
	const gridEnd = lastDay + (6 - weekdayOf(lastDay));

	const todayDay = options.todayIso ? toDay(options.todayIso) : null;

	const weeks: DayCell[][] = [];
	let week: DayCell[] = [];
	let allFreeDays = 0;

	for (let day = gridStart; day <= gridEnd; day++) {
		const iso = fromDay(day);
		const inMonth = day >= firstDay && day <= lastDay;
		const freeIds = active.filter((p) => covers(p.ranges, day)).map((p) => p.id);
		const allFree = countedIds.length >= 2 && freeIds.length === countedIds.length;
		if (allFree && inMonth) allFreeDays++;
		const weekday = weekdayOf(day);

		// "Back at school" is exactly this: not off now, off the day before.
		const returningIds = active
			.filter((p) => !covers(p.ranges, day) && covers(p.ranges, day - 1))
			.map((p) => p.id);

		const reasons = new Map<string, DayReason[]>();
		const tally = new Map<Season, number>();
		let season: Season | null = null;
		for (const id of freeIds) {
			const seen = new Set<string>();
			const mine: DayReason[] = [];
			for (const range of named.get(id) ?? []) {
				if (day < range.start || day > range.end || seen.has(range.label)) continue;
				seen.add(range.label);
				mine.push({ name: range.name, label: range.label, season: range.season });
				const count = (tally.get(range.season) ?? 0) + 1;
				tally.set(range.season, count);
				// First past the post, ties going to whoever got there first, so the mark on a
				// mixed day is the season most of the group is actually in.
				if (season === null || count > (tally.get(season) ?? 0)) season = range.season;
			}
			if (mine.length > 0) reasons.set(id, mine);
		}

		week.push({
			iso,
			dayOfMonth: Number(iso.slice(8, 10)),
			inMonth,
			isToday: todayDay !== null && day === todayDay,
			isWeekend: weekday === 0 || weekday === 6,
			freeIds,
			freeCount: freeIds.length,
			allFree,
			reasons,
			returningIds,
			season,
		});

		if (week.length === 7) {
			weeks.push(week);
			week = [];
		}
	}

	return {
		monthIso: firstIso,
		year,
		month,
		label: `${MONTH_NAMES[month - 1]} ${String(year)}`,
		weeks,
		countedIds,
		allFreeDays,
	};
}

/**
 * The day's reasons with repeated names collapsed, in participant order.
 *
 * Eleven friends at eleven colleges produce eleven separately worded entries for one Labor Day, so
 * anything that reads the day out loud wants the distinct names, not one per person. Matching is
 * case-insensitive because "Labor Day holiday" and "Labor Day Holiday" are two colleges spelling
 * the same day, not two days.
 */
export function distinctReasons(cell: DayCell): DayReason[] {
	const seen = new Set<string>();
	const out: DayReason[] = [];
	for (const id of cell.freeIds) {
		for (const reason of cell.reasons.get(id) ?? []) {
			const key = reason.name.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(reason);
		}
	}
	return out;
}

/** Step a `YYYY-MM-01` month string by whole months. */
export function shiftMonth(monthIso: string, delta: number): string {
	const year = Number(monthIso.slice(0, 4));
	const month = Number(monthIso.slice(5, 7));
	const zero = year * 12 + (month - 1) + delta;
	const newYear = Math.floor(zero / 12);
	const newMonth = (((zero % 12) + 12) % 12) + 1;
	return `${String(newYear).padStart(4, "0")}-${String(newMonth).padStart(2, "0")}-01`;
}

/**
 * Which month to open on.
 *
 * An empty month is a bad first impression, so prefer, in order: the month holding the next
 * all-free stretch, then the month holding the next break anyone has, then the month of the most
 * recent break, then today.
 */
export function pickInitialMonth(participants: Participant[], todayIso: string): string {
	const today = toDay(todayIso);

	const active = participants
		.map((p) => ({ id: p.id, ranges: mergeRanges(p.ranges) }))
		.filter((p) => p.ranges.length > 0);

	if (active.length === 0) return monthOf(today);

	// 1. The next day on which everybody is free.
	if (active.length >= 2) {
		const starts = active.flatMap((p) => p.ranges.map((r) => r.start));
		const ends = active.flatMap((p) => p.ranges.map((r) => r.end));
		const from = Math.max(today, Math.min(...starts));
		const to = Math.max(...ends);
		for (let day = from; day <= to; day++) {
			if (active.every((p) => covers(p.ranges, day))) return monthOf(day);
		}
	}

	// 2. The next break that has not finished yet.
	const upcoming = active
		.flatMap((p) => p.ranges)
		.filter((r) => r.end >= today)
		.toSorted((a, b) => a.start - b.start);
	if (upcoming.length > 0) return monthOf(Math.max(upcoming[0].start, today));

	// 3. Everything is in the past: show where the breaks actually are.
	const latest = active.flatMap((p) => p.ranges).toSorted((a, b) => b.start - a.start)[0];
	return monthOf(latest.start);
}

/** A break row as the page holds it: a span, a person, and where it came from. */
interface SourcedBreak {
	userId: string;
	startDate: string;
	endDate: string;
	source: string;
}

/**
 * Who is only _assumed_ to be free on a day.
 *
 * A federal holiday is a default the app filled in for a kind of workplace, not a check that this
 * particular person is off: duty, watch, shift work and leave are all personal. The grid cannot say
 * that on its own — it reduces every row to a day range and forgets where it came from — so this
 * answers the question the grid dropped, for the one day being looked at.
 *
 * Anyone with a stated reason on that day drops out, even if they also hold an assumed one. The
 * stated reason is what they are shown by, so there is nothing left to hedge.
 */
export function assumedFreeIds(rows: SourcedBreak[], iso: string | null): string[] {
	if (iso === null) return [];
	const day = toDay(iso);
	const covering = rows.filter((row) => toDay(row.startDate) <= day && day <= toDay(row.endDate));
	const stated = new Set(
		covering.filter((row) => row.source !== ASSUMED_SOURCE).map((row) => row.userId),
	);
	return Array.from(
		new Set(
			covering
				.filter((row) => row.source === ASSUMED_SOURCE && !stated.has(row.userId))
				.map((row) => row.userId),
		),
	);
}

/** Rows shaped for the DB: turn stored ISO breaks into engine participants. */
export function toParticipants(
	people: { id: string }[],
	breaks: { userId: string; startDate: string; endDate: string }[],
): Participant[] {
	const byUser = new Map<string, DayRange[]>();
	for (const person of people) byUser.set(person.id, []);
	for (const b of breaks) {
		const list = byUser.get(b.userId);
		if (!list) continue;
		list.push({ start: toDay(b.startDate), end: toDay(b.endDate) });
	}
	return people.map((p) => ({ id: p.id, ranges: byUser.get(p.id) ?? [] }));
}
