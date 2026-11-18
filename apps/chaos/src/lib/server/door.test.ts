import { expect, it } from "vitest";

import { doorDate, doorLabel, todaysDoor } from "./door";
import type { KevEntry } from "./kev";
import { openStore } from "./store";

it("turns the door over at midnight US Eastern", () => {
	expect(doorDate(new Date("2026-11-19T04:59:00Z"))).toBe("2026-11-18");
	expect(doorDate(new Date("2026-11-19T05:00:00Z"))).toBe("2026-11-19");
});

it("labels pre-season, numbered doors and the rest of the year", () => {
	expect(doorLabel("2026-11-18")).toBe("Pre-season");
	expect(doorLabel("2026-11-30")).toBe("Pre-season");
	expect(doorLabel("2026-12-01")).toBe("Door 1");
	expect(doorLabel("2026-12-24")).toBe("Door 24");
	expect(doorLabel("2026-12-25")).toBe("Off season");
});

const entry = (cveId: string, dateAdded: string): KevEntry => ({
	cveId,
	vendor: "Acme",
	product: "Widget",
	name: cveId,
	description: "",
	dateAdded,
	dueDate: "2026-12-09",
	ransomware: false,
});
const NOON = new Date("2026-11-18T17:00:00Z");

it("claims nothing about today before any pull has succeeded", () => {
	expect(todaysDoor(openStore(":memory:"), NOON)).toMatchObject({
		current: false,
		item: undefined,
		checkedAt: undefined,
	});
});

it("is not current when the last successful check was on an earlier day", () => {
	const store = openStore(":memory:");

	store.save([entry("CVE-2026-1", "2026-11-17")], null, new Date("2026-11-17T17:00:00Z"));
	expect(todaysDoor(store, NOON)).toMatchObject({ current: false, addedToday: 0 });
});

it("shows the last day of additions, under its own date, on a quiet day", () => {
	const store = openStore(":memory:");

	store.save([entry("CVE-2026-1", "2026-11-17")], null, NOON);

	expect(todaysDoor(store, NOON)).toMatchObject({
		current: true,
		addedToday: 0,
		shownDate: "2026-11-17",
		item: { cveId: "CVE-2026-1" },
		cause: "attack",
	});
});

it("shows today's additions once CISA has added some", () => {
	const store = openStore(":memory:");

	store.save([entry("CVE-2026-1", "2026-11-17"), entry("CVE-2026-2", "2026-11-18")], null, NOON);

	expect(todaysDoor(store, NOON)).toMatchObject({
		current: true,
		addedToday: 1,
		shownDate: "2026-11-18",
		item: { cveId: "CVE-2026-2" },
	});
});
