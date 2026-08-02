import assert from "node:assert/strict";

import { test } from "vitest";

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

test("deriveRoster moves a gone-quiet resident out of Working and marks fleet health down", () => {
	const fresh = deriveRoster([workingResident], Date.parse(observedAt) + 89_999);
	assert.deepEqual(fresh.lanes.working, [workingResident]);
	assert.equal(fresh.health.working, 1);
	assert.equal(fresh.health.down, 0);

	const goneQuiet = deriveRoster([workingResident], Date.parse(observedAt) + 90_001);
	assert.deepEqual(goneQuiet.lanes.working, []);
	assert.deepEqual(goneQuiet.lanes.needs, [workingResident]);
	assert.equal(goneQuiet.health.working, 0);
	assert.equal(goneQuiet.health.down, 1);
});
