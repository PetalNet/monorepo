import { expect, it } from "vitest";

import { doorDate, doorLabel } from "./door";

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
