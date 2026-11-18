import { expect, it } from "vitest";

import { panel } from "./door";
import type { KevEntry } from "./kev";
import { openStore, type Store } from "./store";

const entry = (cveId: string, dateAdded: string, ransomware = false): KevEntry => ({
	cveId,
	vendor: "Acme",
	product: "Widget",
	name: cveId,
	description: "",
	dateAdded,
	dueDate: "2026-12-09",
	ransomware,
});

function stored(entries: KevEntry[], checked: string): Store {
	const store = openStore(":memory:");

	store.save(entries, null, new Date(checked));

	return store;
}

const at = (iso: string, wanted?: string, store = openStore(":memory:")) =>
	panel(store, new Date(iso), wanted);
const states = (iso: string) =>
	Object.fromEntries(
		Object.entries(Object.groupBy(at(iso).strip, (door) => door.state)).map(([state, doors]) => [
			state,
			doors.map((door) => door.id).join(" "),
		]),
	);
const NOON = "2026-11-18T17:00:00Z";

it("turns the door over at midnight US Eastern", () => {
	expect(at("2026-12-01T04:59:00Z").reading.door.id).toBe("pre");
	expect(at("2026-12-01T05:00:00Z").reading.door.id).toBe("1");
});

it("shows the pre-season door and doors 1 to 24, in order", () => {
	expect(at(NOON).strip.map((door) => door.id)).toEqual([
		"pre",
		...Array.from({ length: 24 }, (_, index) => String(index + 1)),
	]);
});

const numbered = (from: number, to: number) =>
	Array.from({ length: to - from + 1 }, (_, index) => String(from + index)).join(" ");

it("locks every door whose day has not come", () => {
	expect(states(NOON)).toEqual({ today: "pre", locked: numbered(1, 24) });
	expect(states("2026-11-25T17:00:00Z")).toEqual({ today: "pre", locked: numbered(1, 24) });

	expect(states("2026-12-01T17:00:00Z")).toEqual({
		opened: "pre",
		today: "1",
		locked: numbered(2, 24),
	});

	expect(states("2026-12-12T17:00:00Z")).toEqual({
		opened: `pre ${numbered(1, 11)}`,
		today: "12",
		locked: numbered(13, 24),
	});
});

it("keeps the finished season on show, with no door for today, until the next one starts", () => {
	expect(states("2026-12-25T17:00:00Z")).toEqual({
		opened: `pre ${numbered(1, 24)}`,
	});

	expect(at("2027-11-17T17:00:00Z").strip[0]).toMatchObject({
		from: "2026-11-18",
		state: "opened",
	});

	expect(at("2027-11-18T17:00:00Z").strip[0]).toMatchObject({ from: "2027-11-18", state: "today" });
	expect(at("2026-12-25T17:00:00Z").reading.door.id).toBe("24");
});

it("opens today's door unless the visitor asked for an opened one", () => {
	expect(at("2026-12-12T17:00:00Z").reading.door.id).toBe("12");
	expect(at("2026-12-12T17:00:00Z", "3").reading.door.id).toBe("3");
	expect(at("2026-12-12T17:00:00Z", "pre").reading.door.id).toBe("pre");
});

it("never opens a locked or unknown door", () => {
	const store = stored([entry("CVE-2026-9", "2026-12-20")], "2026-12-12T17:00:00Z");

	for (const wanted of ["20", "13", "25", "0", "../x", ""]) {
		expect(at("2026-12-12T17:00:00Z", wanted, store).reading.door.id).toBe("12");
	}

	expect(
		at("2026-12-12T17:00:00Z", undefined, store).strip.find((door) => door.id === "20"),
	).toMatchObject({
		state: "locked",
		added: undefined,
	});
});

it("counts each door's additions and leaves locked doors without a count", () => {
	const store = stored(
		[
			entry("CVE-2026-1", "2026-11-17"),
			entry("CVE-2026-2", "2026-11-18"),
			entry("CVE-2026-3", "2026-11-30"),
			entry("CVE-2026-4", "2026-12-02"),
			entry("CVE-2026-5", "2026-12-02"),
		],
		"2026-12-03T17:00:00Z",
	);

	expect(
		at("2026-12-03T17:00:00Z", undefined, store)
			.strip.slice(0, 5)
			.map((door) => door.added),
	).toEqual([2, 0, 2, 0, undefined]);
});

it("claims nothing about today before any pull has succeeded", () => {
	expect(at(NOON)).toMatchObject({
		reading: { current: false, item: undefined },
		checkedAt: undefined,
		catalogSize: 0,
	});
});

it("is not current when the last successful check was on an earlier day", () => {
	const store = stored([entry("CVE-2026-1", "2026-11-17")], "2026-11-17T17:00:00Z");

	expect(at(NOON, undefined, store).reading).toMatchObject({ current: false, added: 0 });
});

it("shows the last day of additions, under its own date, on a quiet day", () => {
	const store = stored([entry("CVE-2026-1", "2026-11-17")], NOON);

	expect(at(NOON, undefined, store).reading).toMatchObject({
		current: true,
		added: 0,
		shownDate: "2026-11-17",
		item: { cveId: "CVE-2026-1" },
		cause: "attack",
	});
});

it("shows today's additions once CISA has added some", () => {
	const store = stored(
		[entry("CVE-2026-1", "2026-11-17"), entry("CVE-2026-2", "2026-11-18")],
		NOON,
	);

	expect(at(NOON, undefined, store).reading).toMatchObject({
		current: true,
		added: 1,
		shownDate: "2026-11-18",
		item: { cveId: "CVE-2026-2" },
	});
});

it("reads an opened door from its own dates only, with no fallback", () => {
	const store = stored(
		[
			entry("CVE-2026-1", "2026-11-20"),
			entry("CVE-2026-2", "2026-11-29", true),
			entry("CVE-2026-3", "2026-12-01"),
		],
		"2026-12-03T17:00:00Z",
	);

	expect(at("2026-12-03T17:00:00Z", "pre", store).reading).toMatchObject({
		current: true,
		added: 2,
		shownDate: "2026-11-29",
		item: { cveId: "CVE-2026-2" },
	});

	expect(at("2026-12-03T17:00:00Z", "2", store).reading).toMatchObject({
		current: true,
		added: 0,
		item: undefined,
		shownDate: undefined,
	});
});

it("does not vouch for an opened door until a pull has succeeded after it closed", () => {
	const store = stored([entry("CVE-2026-3", "2026-12-01")], "2026-12-01T17:00:00Z");

	expect(at("2026-12-02T17:00:00Z", "1", store).reading.current).toBe(false);
	store.markChecked(new Date("2026-12-02T05:00:00Z"));
	expect(at("2026-12-02T17:00:00Z", "1", store).reading.current).toBe(true);
});

it("names the next door and the instant it unlocks, on either side of the clock change", () => {
	expect(at(NOON).next).toEqual({ label: "Door 1", opensAt: "2026-12-01T05:00:00.000Z" });

	expect(at("2026-12-23T17:00:00Z").next).toEqual({
		label: "Door 24",
		opensAt: "2026-12-24T05:00:00.000Z",
	});

	expect(at("2026-12-24T17:00:00Z").next).toBeUndefined();
});
