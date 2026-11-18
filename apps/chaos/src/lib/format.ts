/** "November 18" for an ISO date as CISA publishes it. */
export function day(iso: string, month: "long" | "short" = "long"): string {
	return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", {
		month,
		day: "numeric",
		timeZone: "UTC",
	});
}

/** "Wednesday, November 18" */
export function weekday(iso: string): string {
	return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", {
		weekday: "long",
		month: "long",
		day: "numeric",
		timeZone: "UTC",
	});
}

/** A moment on the door clock: "Nov 18, 3:04 PM ET". */
export function clock(iso: string): string {
	return `${new Date(iso).toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZone: "America/New_York",
	})} ET`;
}

export function plural(count: number, one: string, many: string): string {
	return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}
