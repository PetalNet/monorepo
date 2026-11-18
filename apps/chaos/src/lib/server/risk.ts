import type { Store } from "./store";

/** The meter compares the last seven days with each of the 52 weeks before them. */
const BASELINE_WEEKS = 52;

export type RiskLevel = "quiet" | "busy" | "heavy";

export type Risk = {
	/** How many weeks the last seven days are compared with. */
	baselineWeeks: number;
} &
	/** No pull has succeeded today, so the last seven days cannot be counted. */
	(
		| { kind: "stale" }
		/** The stored list does not reach back far enough to fill the baseline. No number is shown. */
		| { kind: "short"; days: number; needed: number }
		| {
				kind: "reading";
				/** Vulnerabilities CISA added in the seven days ending today. */
				week: number;
				/** How many of the 52 baseline weeks had fewer additions than this one. */
				quieterWeeks: number;
				level: RiskLevel;
				median: number;
				/** Oldest first, ending with the current week. */
				weeks: { end: string; added: number }[];
		  }
	);

function addDays(date: string, days: number): string {
	const moved = new Date(`${date}T12:00:00Z`);

	moved.setUTCDate(moved.getUTCDate() + days);

	return moved.toISOString().slice(0, 10);
}

/** Code sets the label from the count alone: the top tenth of weeks is heavy, the top half busy. */
function levelOf(quieterWeeks: number): RiskLevel {
	if (quieterWeeks >= BASELINE_WEEKS * 0.9) {
		return "heavy";
	}

	return quieterWeeks >= BASELINE_WEEKS / 2 ? "busy" : "quiet";
}

/**
 * The cyber risk reading for `date` (today on the door clock, with `checkedDate` the day of the
 * last successful pull). The baseline is CISA's own record: every entry carries the day it was
 * added, so the list is its own history.
 */
export function risk(store: Store, date: string, checkedDate: string): Risk {
	if (checkedDate !== date) {
		return { baselineWeeks: BASELINE_WEEKS, kind: "stale" };
	}

	const needed = (BASELINE_WEEKS + 1) * 7;
	const first = addDays(date, 1 - needed);
	const earliest = store.earliestDay();
	const days = earliest
		? Math.round(
				(Date.parse(`${date}T12:00:00Z`) - Date.parse(`${earliest}T12:00:00Z`)) / 86_400_000,
			) + 1
		: 0;

	if (days < needed) {
		return { baselineWeeks: BASELINE_WEEKS, kind: "short", days, needed };
	}

	const counts = store.countsByDay(first, date);
	const weeks = Array.from({ length: BASELINE_WEEKS + 1 }, (_, index) => {
		const start = addDays(first, index * 7);
		let added = 0;

		for (let offset = 0; offset < 7; offset += 1) {
			added += counts.get(addDays(start, offset)) ?? 0;
		}

		return { end: addDays(start, 6), added };
	});
	const baseline = weeks.slice(0, -1).map((week) => week.added);
	const week = weeks.at(-1)?.added ?? 0;
	const quieterWeeks = baseline.filter((added) => added < week).length;
	const sorted = baseline.toSorted((a, b) => a - b);
	const middle = sorted.length / 2;

	return {
		baselineWeeks: BASELINE_WEEKS,
		kind: "reading",
		week,
		quieterWeeks,
		level: levelOf(quieterWeeks),
		median: ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2,
		weeks,
	};
}
