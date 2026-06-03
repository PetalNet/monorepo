/** Timezone utility functions for consistent date/time handling across the app */

/** Format a date in a specific timezone */
export function formatInTimezone(
	date: Date | string,
	timezone: string,
	options: Intl.DateTimeFormatOptions = {},
): string {
	const dateObj = typeof date === "string" ? new Date(date) : date;

	const defaultOptions: Intl.DateTimeFormatOptions = {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		...options,
	};

	return new Intl.DateTimeFormat("en-US", {
		...defaultOptions,
		timeZone: timezone,
	}).format(dateObj);
}

/** Format a date for datetime-local input Converts a UTC date to the event's timezone for editing */
export function toDateTimeLocal(date: Date | string, timezone: string): string {
	const dateObj = typeof date === "string" ? new Date(date) : date;

	// Get the date/time components in the event's timezone
	const year = dateObj.toLocaleString("en-US", {
		year: "numeric",
		timeZone: timezone,
	});
	const month = dateObj
		.toLocaleString("en-US", { month: "2-digit", timeZone: timezone })
		.padStart(2, "0");
	const day = dateObj
		.toLocaleString("en-US", { day: "2-digit", timeZone: timezone })
		.padStart(2, "0");
	const hour = dateObj
		.toLocaleString("en-US", {
			hour: "2-digit",
			hour12: false,
			timeZone: timezone,
		})
		.padStart(2, "0");
	const minute = dateObj
		.toLocaleString("en-US", { minute: "2-digit", timeZone: timezone })
		.padStart(2, "0");

	return `${year}-${month}-${day}T${hour}:${minute}`;
}

/** Get short timezone abbreviation (e.g., "EST", "PST") */
export function getTimezoneAbbr(timezone: string, date?: Date): string {
	const dateObj = date || new Date();

	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		timeZoneName: "short",
	});

	const parts = formatter.formatToParts(dateObj);
	const tzPart = parts.find((part) => part.type === "timeZoneName");

	return tzPart?.value || timezone;
}

/** Common timezone options for dropdowns */
export const COMMON_TIMEZONES = [
	{ value: "America/New_York", label: "Eastern Time (ET)" },
	{ value: "America/Chicago", label: "Central Time (CT)" },
	{ value: "America/Denver", label: "Mountain Time (MT)" },
	{ value: "America/Los_Angeles", label: "Pacific Time (PT)" },
	{ value: "America/Phoenix", label: "Arizona (MST)" },
	{ value: "America/Anchorage", label: "Alaska (AKT)" },
	{ value: "Pacific/Honolulu", label: "Hawaii (HST)" },
	{ value: "Europe/London", label: "London (GMT/BST)" },
	{ value: "Europe/Paris", label: "Paris (CET/CEST)" },
	{ value: "Europe/Berlin", label: "Berlin (CET/CEST)" },
	{ value: "Asia/Tokyo", label: "Tokyo (JST)" },
	{ value: "Asia/Shanghai", label: "Shanghai (CST)" },
	{ value: "Asia/Dubai", label: "Dubai (GST)" },
	{ value: "Australia/Sydney", label: "Sydney (AEST/AEDT)" },
	{ value: "UTC", label: "UTC" },
];

/** Get user's browser timezone */
export function getUserTimezone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Format relative time with timezone context */
export function formatRelativeWithTimezone(date: Date | string, timezone: string): string {
	const dateObj = typeof date === "string" ? new Date(date) : date;
	const now = new Date();
	const diffMs = dateObj.getTime() - now.getTime();
	const diffMins = Math.floor(diffMs / (1000 * 60));
	const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
	const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

	// For past dates
	if (diffMs < 0) {
		const absDays = Math.abs(diffDays);
		if (absDays === 0) {
			const absHours = Math.abs(diffHours);
			if (absHours === 0) {
				const absMins = Math.abs(diffMins);
				return `${absMins} minute${absMins !== 1 ? "s" : ""} ago`;
			}
			return `${absHours} hour${absHours !== 1 ? "s" : ""} ago`;
		}
		if (absDays < 7) {
			return `${absDays} day${absDays !== 1 ? "s" : ""} ago`;
		}
		return formatInTimezone(dateObj, timezone, {
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
		});
	}

	// For future dates
	if (diffDays === 0) {
		if (diffHours === 0) {
			return `in ${diffMins} minute${diffMins !== 1 ? "s" : ""}`;
		}
		return `in ${diffHours} hour${diffHours !== 1 ? "s" : ""}`;
	}
	if (diffDays < 7) {
		return `in ${diffDays} day${diffDays !== 1 ? "s" : ""}`;
	}

	return formatInTimezone(dateObj, timezone, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}
