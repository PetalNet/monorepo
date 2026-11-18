import { publicSafety } from "$lib/server/alerts";
import { doorDate, panel } from "$lib/server/door";
import { hitCheck } from "$lib/server/hit/check";
import { ICS_SOURCE, icsGauge } from "$lib/server/ics";
import { chaos } from "$lib/server/news";
import { board } from "$lib/server/status/board";
import { gap } from "$lib/server/weekly";

import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals: { store }, url }) => {
	const now = new Date();
	const doors = panel(store, now, url.searchParams.get("door") ?? undefined);
	const noise = chaos(store, now);
	const services = board(store, now);

	return {
		...doors,
		chaos: noise,
		ics: {
			gauge: icsGauge(store, doors.date, now),
			checkedAt: store.source(ICS_SOURCE)?.checkedAt,
		},
		safety: publicSafety(store, doors.date, now, doorDate),
		gap: gap(noise.gauge, doors.risk),
		board: services,
		hit: await hitCheck(store, services.rows, url.searchParams.get("domain"), doors.date, now),
		now: now.toISOString(),
	};
};
