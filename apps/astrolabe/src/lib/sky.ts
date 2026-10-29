export interface SolarEvent {
	at: number | null;
	kind: "sunrise" | "sunset" | null;
}

export interface SolarTimes {
	sunriseAt: number | null;
	sunsetAt: number | null;
	nextDaySunriseAt: number | null;
}

/**
 * The first dated sunrise or sunset still ahead of `now`, so an event that passes between polls
 * drops out.
 */
export const nextSolarEvent = (times: SolarTimes, now: number): SolarEvent => {
	const candidates: SolarEvent[] = [
		{ at: times.sunriseAt, kind: "sunrise" },
		{ at: times.sunsetAt, kind: "sunset" },
		{ at: times.nextDaySunriseAt, kind: "sunrise" },
	];

	for (const event of candidates) {
		if (event.at !== null && event.at > now) return event;
	}

	return { at: null, kind: null };
};

/**
 * Minutes until the next sunrise or sunset, from epoch timestamps. Wall-clock minutes are wrong
 * here: a DST change between now and the event moves the clock an hour without moving the sun.
 */
export const solarCountdown = (
	times: SolarTimes,
	now: number,
): { kind: "sunrise" | "sunset"; minutes: number } | null => {
	const next = nextSolarEvent(times, now);

	return next.at === null || next.kind === null
		? null
		: { kind: next.kind, minutes: (next.at - now) / 60_000 };
};
