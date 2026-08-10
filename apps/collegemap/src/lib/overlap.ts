/**
 * The overlap engine: given everyone's break periods, find the stretches of calendar where the same
 * set of people are all off at once.
 *
 * Everything here is integer day numbers (see `dates.ts`). No `Date` objects, no timezones, no
 * floating point.
 */

import { dayCount, fromDay, toDay } from "./dates";

export interface DayRange {
	/** Inclusive, day number. */
	start: number;
	/** Inclusive, day number. Equal to `start` for a single-day break. */
	end: number;
}

export interface Participant {
	id: string;
	/** May be empty: someone who has joined but not entered anything yet. */
	ranges: DayRange[];
}

export interface FreeWindow {
	startDay: number;
	endDay: number;
	start: string;
	end: string;
	/** Inclusive day count. */
	days: number;
	/** Ids of everyone off for the whole window, in input order. */
	freeIds: string[];
	/** Ids of participants who are not, in input order. */
	missingIds: string[];
}

/**
 * Sort and merge one person's own ranges. Overlapping ranges collapse, and so do _adjacent_ ones: a
 * break ending Dec 24 and another starting Dec 25 is one continuous stretch of not being at
 * school.
 */
export function mergeRanges(ranges: DayRange[]): DayRange[] {
	if (ranges.length === 0) return [];
	const sorted = ranges.toSorted((a, b) => a.start - b.start || a.end - b.end);
	const merged: DayRange[] = [{ ...sorted[0] }];
	for (let i = 1; i < sorted.length; i++) {
		const next = sorted[i];
		const last = merged[merged.length - 1];
		if (next.start <= last.end + 1) {
			if (next.end > last.end) last.end = next.end;
		} else {
			merged.push({ ...next });
		}
	}
	return merged;
}

function covers(ranges: DayRange[], day: number): boolean {
	for (const r of ranges) {
		if (day < r.start) return false;
		if (day <= r.end) return true;
	}
	return false;
}

/**
 * Every maximal stretch of days over which the free set does not change.
 *
 * Method: collect the boundaries (each range's start, and each range's end + 1, which is the first
 * day the person is back). Between two consecutive boundaries nobody's status changes, so each gap
 * has one constant free set. Then glue touching gaps that have the identical free set.
 *
 * Internal: `buildReport` is the surface, and it is what decides which of these windows are worth
 * showing.
 *
 * Deliberately the obvious O(boundaries x people) version rather than a clever counting sweep: a
 * friend group is a handful of people with a handful of breaks, and a counting sweep cannot tell
 * you _which_ people are free without extra bookkeeping, which is exactly where the bugs live.
 */
function computeWindows(participants: Participant[]): FreeWindow[] {
	const active = participants
		.map((p) => ({ id: p.id, ranges: mergeRanges(p.ranges) }))
		.filter((p) => p.ranges.length > 0);

	const boundarySet = new Set<number>();
	for (const p of active) {
		for (const r of p.ranges) {
			boundarySet.add(r.start);
			boundarySet.add(r.end + 1);
		}
	}
	const boundaries = [...boundarySet].toSorted((a, b) => a - b);

	interface Segment {
		start: number;
		end: number;
		freeIds: string[];
		key: string;
	}
	const segments: Segment[] = [];

	for (let i = 0; i < boundaries.length - 1; i++) {
		const start = boundaries[i];
		const end = boundaries[i + 1] - 1;
		if (end < start) continue;
		const freeIds = active.filter((p) => covers(p.ranges, start)).map((p) => p.id);
		segments.push({ start, end, freeIds, key: freeIds.join("\u0000") });
	}

	const windows: FreeWindow[] = [];
	for (const seg of segments) {
		const prev = windows.at(-1);
		const prevKey = prev ? prev.freeIds.join("\u0000") : null;
		if (prev && prevKey === seg.key && prev.endDay + 1 === seg.start) {
			prev.endDay = seg.end;
			prev.end = fromDay(seg.end);
			prev.days = dayCount(prev.startDay, prev.endDay);
			continue;
		}
		const freeSet = new Set(seg.freeIds);
		windows.push({
			startDay: seg.start,
			endDay: seg.end,
			start: fromDay(seg.start),
			end: fromDay(seg.end),
			days: dayCount(seg.start, seg.end),
			freeIds: seg.freeIds,
			missingIds: active.filter((p) => !freeSet.has(p.id)).map((p) => p.id),
		});
	}

	return windows;
}

export interface WindowReport {
	/** Participants who have entered at least one break. The denominator. */
	counted: string[];
	/** Joined the group, entered nothing. Cannot appear in any window. */
	silent: string[];
	/** Windows where every counted person is free, longest first. */
	everyone: FreeWindow[];
	/** Windows missing one or two people, best first. */
	almost: FreeWindow[];
}

export interface ReportOptions {
	/** Windows that already ended before this day are dropped. */
	todayIso?: string;
	/** Cap on how many near-miss windows come back. */
	almostLimit?: number;
}

/**
 * The whole answer for one group, ready to render.
 *
 * A person with no breaks entered is _not_ counted in the denominator. If they were, one silent
 * friend would make the all-free list permanently empty and the app would look broken rather than
 * incomplete. They are returned in `silent` so the UI can say so out loud.
 */
export function buildReport(
	participants: Participant[],
	options: ReportOptions = {},
): WindowReport {
	const counted = participants.filter((p) => p.ranges.length > 0).map((p) => p.id);
	const silent = participants.filter((p) => p.ranges.length === 0).map((p) => p.id);

	const cutoff = options.todayIso ? toDay(options.todayIso) : null;
	const all = computeWindows(participants).filter((w) => cutoff === null || w.endDay >= cutoff);

	const everyone = all
		.filter((w) => w.freeIds.length === counted.length && counted.length >= 2)
		.toSorted((a, b) => b.days - a.days || a.startDay - b.startDay);

	// How near a near-miss may be. With four friends, "3 of 4" is the story.
	// With seven, "5 of 7" is still worth surfacing.
	const nearFloor = Math.max(2, counted.length - (counted.length >= 5 ? 2 : 1));

	const almost = all
		.filter((w) => w.freeIds.length >= nearFloor && w.freeIds.length < counted.length)
		.toSorted(
			(a, b) => b.freeIds.length - a.freeIds.length || b.days - a.days || a.startDay - b.startDay,
		)
		.slice(0, options.almostLimit ?? 8);

	return { counted, silent, everyone, almost };
}
