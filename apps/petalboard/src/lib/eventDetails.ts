export interface CalendarEvent {
	uid: string;
	title: string;
	start: Date;
	end: Date | null;
	location: string | null;
	url: string;
}

/** Calendars render an event with no end as a zero-length blip, so assume an evening. */
const DEFAULT_LENGTH_MS = 3 * 60 * 60 * 1000;

const icsDate = (d: Date) =>
	d
		.toISOString()
		.replaceAll(/[-:]/g, "")
		.replace(/\.\d{3}/, "");

const icsText = (s: string) =>
	s
		.replaceAll("\\", "\\\\")
		.replaceAll(";", "\\;")
		.replaceAll(",", "\\,")
		.replaceAll(/\r?\n/g, "\\n");

/** RFC 5545 caps content lines at 75 octets; continuation lines start with a space. */
function fold(line: string): string {
	const bytes = new TextEncoder().encode(line);

	if (bytes.length <= 75) {
		return line;
	}

	const parts: string[] = [];
	let current = "";
	let size = 0;

	for (const ch of line) {
		const len = new TextEncoder().encode(ch).length;
		const limit = parts.length === 0 ? 75 : 74;

		if (size + len > limit) {
			parts.push(current);
			current = "";
			size = 0;
		}

		current += ch;
		size += len;
	}

	parts.push(current);

	return parts.join("\r\n ");
}

export function buildIcs(event: CalendarEvent, now: Date = new Date()): string {
	const end = event.end ?? new Date(event.start.getTime() + DEFAULT_LENGTH_MS);
	const lines = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//PetalBoard//RSVP//EN",
		"CALSCALE:GREGORIAN",
		"METHOD:PUBLISH",
		"BEGIN:VEVENT",
		`UID:${event.uid}`,
		`DTSTAMP:${icsDate(now)}`,
		`DTSTART:${icsDate(event.start)}`,
		`DTEND:${icsDate(end)}`,
		`SUMMARY:${icsText(event.title)}`,
		...(event.location ? [`LOCATION:${icsText(event.location)}`] : []),
		`URL:${event.url}`,
		`DESCRIPTION:${icsText(`RSVP and details: ${event.url}`)}`,
		"END:VEVENT",
		"END:VCALENDAR",
	];

	return `${lines.map(fold).join("\r\n")}\r\n`;
}

export function directionsUrl(location: string): string {
	return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(location)}`;
}

interface CountedRsvp {
	status: string;
	guestCount: number;
}

/** People, not RSVPs: each RSVP counts its whole party. */
export function headcount(rsvps: readonly CountedRsvp[]): { coming: number; maybe: number } {
	let coming = 0;
	let maybe = 0;

	for (const r of rsvps) {
		if (r.status === "attending") {
			coming += r.guestCount;
		} else if (r.status === "maybe") {
			maybe += r.guestCount;
		}
	}

	return { coming, maybe };
}
