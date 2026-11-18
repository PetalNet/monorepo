import { KEV_CAUSE, worst, type Cause, type KevEntry } from "./kev";
import type { Store } from "./store";

/** CISA dates entries in US Eastern time, so a door opens and closes on that clock. */
function doorDate(now: Date): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
}

function doorLabel(date: string): string {
	const monthDay = date.slice(5);

	if (monthDay >= "11-18" && monthDay <= "11-30") {
		return "Pre-season";
	}

	if (monthDay >= "12-01" && monthDay <= "12-24") {
		return `Door ${String(Number(monthDay.slice(3)))}`;
	}

	return "Off season";
}

export interface Door {
	date: string;
	label: string;
	/**
	 * False until a pull has succeeded on the door's own day. The page claims nothing about today
	 * without it.
	 */
	current: boolean;
	addedToday: number;
	/**
	 * The worst entry of `shownDate`: today when CISA added something, else its last day of
	 * additions.
	 */
	item: KevEntry | undefined;
	shownDate: string | undefined;
	shownCount: number;
	cause: Cause;
	checkedAt: string | undefined;
}

export function todaysDoor(store: Store, now: Date): Door {
	const date = doorDate(now);
	const checkedAt = store.checkedAt();
	const today = store.addedOn(date);
	const shownDate = today.length > 0 ? date : store.latestDayBefore(date);
	const shown = today.length > 0 ? today : shownDate ? store.addedOn(shownDate) : [];

	return {
		date,
		label: doorLabel(date),
		current: checkedAt !== undefined && doorDate(new Date(checkedAt)) === date,
		addedToday: today.length,
		item: worst(shown),
		shownDate,
		shownCount: shown.length,
		cause: KEV_CAUSE,
		checkedAt,
	};
}
