/** CISA dates entries in US Eastern time, so a door opens and closes on that clock. */
export function doorDate(now: Date): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
}

export function doorLabel(date: string): string {
	const monthDay = date.slice(5);

	if (monthDay >= "11-18" && monthDay <= "11-30") {
		return "Pre-season";
	}

	if (monthDay >= "12-01" && monthDay <= "12-24") {
		return `Door ${String(Number(monthDay.slice(3)))}`;
	}

	return "Off season";
}
