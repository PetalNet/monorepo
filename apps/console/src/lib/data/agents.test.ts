import { describe, expect, it } from "vitest";

import type { RosterItem } from "../api/types.ts";
import { deriveRoster } from "./agents.ts";

const observedAt = "2026-07-13T12:00:00.000Z";
const workingResident = {
	handle: "eleanor",
	status: "working",
	heartbeat_state: "running",
	workers_active: 0,
	updated_at: observedAt,
	observed_at: observedAt,
} satisfies RosterItem;

describe("deriveRoster", () => {
	it("moves a gone-quiet resident out of Working and marks fleet health down", () => {
		const fresh = deriveRoster([workingResident], Date.parse(observedAt) + 89_999);
		expect(fresh.lanes.working).toEqual([workingResident]);
		expect(fresh.health.working).toBe(1);
		expect(fresh.health.down).toBe(0);

		const goneQuiet = deriveRoster([workingResident], Date.parse(observedAt) + 90_001);
		expect(goneQuiet.lanes.working).toEqual([]);
		expect(goneQuiet.lanes.needs).toEqual([workingResident]);
		expect(goneQuiet.health.working).toBe(0);
		expect(goneQuiet.health.down).toBe(1);
	});
});
