import { doorDate, doorLabel } from "$lib/server/door";
import { KEV_CAUSE, worst } from "$lib/server/kev";

import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals: { store } }) => {
	const date = doorDate(new Date());
	const today = store.addedOn(date);
	// A quiet day shows the last day CISA did add something, under its own date.
	const shownDate = today.length > 0 ? date : store.latestDayBefore(date);
	const shown = today.length > 0 ? today : shownDate ? store.addedOn(shownDate) : [];

	return {
		date,
		label: doorLabel(date),
		addedToday: today.length,
		shownDate,
		shownCount: shown.length,
		item: worst(shown),
		cause: KEV_CAUSE,
		checkedAt: store.checkedAt(),
	};
};
