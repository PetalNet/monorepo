import { describe, expect, it } from "vitest";

import { buildIcs, directionsUrl, headcount } from "./eventDetails";

const base = {
	uid: "evt1@petalboard",
	title: "Friendsgiving - 2026",
	start: new Date("2026-11-28T23:00:00Z"),
	end: null,
	location: "1 Main St, Springfield, MO",
	url: "https://rsvp.example.test/event/ABC12345",
};

const unfold = (ics: string) => ics.replaceAll("\r\n ", "");

describe("buildIcs", () => {
	const ics = buildIcs(base, new Date("2026-10-29T00:00:00Z"));

	it("is one VEVENT inside a VCALENDAR with CRLF line endings", () => {
		expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
		expect(ics.endsWith("END:VEVENT\r\nEND:VCALENDAR\r\n")).toBe(true);
		expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
		expect(ics.replaceAll("\r\n", "")).not.toContain("\n");
	});

	it("starts at the event time in UTC and assumes three hours without an end", () => {
		expect(ics).toContain("DTSTART:20261128T230000Z\r\n");
		expect(ics).toContain("DTEND:20261129T020000Z\r\n");
	});

	it("uses the event's own end when it has one", () => {
		const withEnd = buildIcs({ ...base, end: new Date("2026-11-29T04:30:00Z") });

		expect(withEnd).toContain("DTEND:20261129T043000Z\r\n");
	});

	it("escapes commas and semicolons in the title and location", () => {
		const out = unfold(buildIcs({ ...base, title: "Eat; drink, repeat" }));

		expect(out).toContain("SUMMARY:Eat\\; drink\\, repeat\r\n");
		expect(out).toContain("LOCATION:1 Main St\\, Springfield\\, MO\r\n");
	});

	it("folds lines longer than 75 octets", () => {
		const long = buildIcs({ ...base, title: "x".repeat(200) });

		for (const line of long.split("\r\n")) {
			expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
		}

		expect(unfold(long)).toContain(`SUMMARY:${"x".repeat(200)}\r\n`);
	});
});

describe("directionsUrl", () => {
	it("routes to the encoded address in Google Maps", () => {
		expect(directionsUrl("1 Main St, Springfield & Co")).toBe(
			"https://www.google.com/maps/dir/?api=1&destination=1%20Main%20St%2C%20Springfield%20%26%20Co",
		);
	});
});

describe("headcount", () => {
	it("counts every person in a party and leaves out people who can't come", () => {
		expect(
			headcount([
				{ status: "attending", guestCount: 3 },
				{ status: "attending", guestCount: 1 },
				{ status: "maybe", guestCount: 2 },
				{ status: "not_attending", guestCount: 4 },
			]),
		).toEqual({ coming: 4, maybe: 2 });
	});
});
