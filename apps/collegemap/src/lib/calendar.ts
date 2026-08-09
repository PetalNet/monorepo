/**
 * The month-grid layer on top of the overlap engine.
 *
 * `overlap.ts` answers "which stretches of calendar is the group free?". A calendar asks the
 * transposed question: "for this one square, who is off?". This module does that transpose, and
 * nothing else. All arithmetic stays in integer day numbers so a timezone can never move a break by
 * a day.
 */

import { fromDay, startOfMonth, startOfNextMonth, toDay } from "./dates";
import { mergeRanges, type DayRange, type Participant } from "./overlap";

/** Day number of 1970-01-01 was a Thursday, so +4 lands Sunday on 0. */
export function weekdayOf(dayNumber: number): number {
	return (((dayNumber + 4) % 7) + 7) % 7;
}

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

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

export interface MonthOptions {
	/** `YYYY-MM-DD`; the day to mark as today. Omit to mark none. */
	todayIso?: string;
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

		week.push({
			iso,
			dayOfMonth: Number(iso.slice(8, 10)),
			inMonth,
			isToday: todayDay !== null && day === todayDay,
			isWeekend: weekday === 0 || weekday === 6,
			freeIds,
			freeCount: freeIds.length,
			allFree,
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
