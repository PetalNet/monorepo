import type { Store } from "./store";
import { weekly, type Gauge } from "./weekly";

/**
 * The cyber risk reading for `date` (today on the door clock, with `checkedDate` the day of the
 * last successful pull): the last seven days of additions to CISA's exploited list against the 52
 * weeks before them. The baseline is CISA's own record, since every entry carries the day it was
 * added.
 */
export function risk(store: Store, date: string, checkedDate: string): Gauge {
	// No pull has succeeded today, so the last seven days cannot be counted.
	if (checkedDate !== date) {
		return { of: 52, kind: "stale" };
	}

	return weekly(store.countsByDay, store.earliestDay(), date);
}
