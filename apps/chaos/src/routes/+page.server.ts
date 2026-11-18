import { publicSafety } from "$lib/server/alerts";
import { doorDate, panel } from "$lib/server/door";
import { ICS_SOURCE, icsGauge } from "$lib/server/ics";
import { chaos } from "$lib/server/news";
import { board } from "$lib/server/status/board";
import { gap } from "$lib/server/weekly";

import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals: { store }, url }) => {
	const now = new Date();
	const doors = panel(store, now, url.searchParams.get("door") ?? undefined);
	const noise = chaos(store, now);

	return {
		...doors,
		chaos: noise,
		ics: {
			gauge: icsGauge(store, doors.date, now),
			checkedAt: store.source(ICS_SOURCE)?.checkedAt,
		},
		safety: publicSafety(store, doors.date, now, doorDate),
		gap: gap(noise.gauge, doors.risk),
		board: board(store, now),
		now: now.toISOString(),
	};
};
