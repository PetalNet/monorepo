import { formatDuration } from "./format.js";

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
		if (event.at !== null && event.at > now) {
			return event;
		}
	}

	return { at: null, kind: null };
};

/**
 * Minutes until the next sunrise or sunset, from epoch timestamps. Wall-clock minutes are wrong
 * here: a DST change between now and the event moves the clock an hour without moving the sun.
 *
 * @internal Exported for its tests; sunCaption is the module's interface.
 */
export const solarCountdown = (
	times: SolarTimes,
	now: number,
): { kind: "sunrise" | "sunset"; at: number; minutes: number } | null => {
	const next = nextSolarEvent(times, now);

	return next.at === null || next.kind === null
		? null
		: { kind: next.kind, at: next.at, minutes: (next.at - now) / 60_000 };
};

/**
 * The day dial's sun caption: today's other event, then the next one with how long until it. The
 * next event is printed from its own timestamp, which after sunset is tomorrow's sunrise.
 */
export const sunCaption = (
	times: SolarTimes,
	now: number,
	clock: (epoch: number) => string,
): string | null => {
	if (times.sunriseAt === null || times.sunsetAt === null) {
		return null;
	}

	const next = solarCountdown(times, now);

	if (next === null) {
		return `Sunrise ${clock(times.sunriseAt)}. Sunset ${clock(times.sunsetAt)}.`;
	}

	const until = `in ${formatDuration(next.minutes * 60_000)}`;

	return next.kind === "sunset"
		? `Sunrise ${clock(times.sunriseAt)}. Sunset ${clock(next.at)}, ${until}.`
		: `Sunset ${clock(times.sunsetAt)}. Sunrise ${clock(next.at)}, ${until}.`;
};
