import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	consoleHealthBusAgeS,
	flattenRosterItem,
	signalSeverityLabel,
	type JoinedRosterItem,
} from "./derive.ts";

describe("signalSeverityLabel", () => {
	it("maps every signal severity to its canonical operator grade", () => {
		assert.deepEqual(
			(["p0", "danger", "warn", "info", "debug"] as const).map(signalSeverityLabel),
			["P0", "P1", "P2", "P3", "feed only"],
		);
	});
});

describe("consoleHealthBusAgeS", () => {
	it("requires explicit bridge proof and measures its clock", () => {
		const now = Date.parse("2026-07-13T12:00:30.000Z");
		assert.equal(
			consoleHealthBusAgeS({ lake: "ok", seq_head: 9, bridges: [], ws_clients: 3 }, now),
			null,
		);
		assert.equal(
			consoleHealthBusAgeS(
				{
					lake: "ok",
					seq_head: 9,
					bridges: [{ observed_at: "2026-07-13T12:00:22.000Z" }],
				},
				now,
			),
			8,
		);
	});
});

describe("flattenRosterItem", () => {
	const absent = { visibility: "absent", observed_at: null, data: null } as const;

	it("adapts the source-preserving join without discarding source freshness", () => {
		const row: JoinedRosterItem = {
			handle: "janet",
			workers_active: 2,
			fleet: {
				visibility: "visible",
				observed_at: "2026-07-13T12:00:02.000Z",
				data: {
					host: ".202",
					status: "working",
					task_id: 712,
					updated_at: "2026-07-13T12:00:01.000Z",
				},
			},
			heartbeat: {
				visibility: "visible",
				observed_at: "2026-07-13T12:00:03.000Z",
				data: { state: "running", crash_count: 2, channel_lock: { state: "held" } },
			},
			registry: {
				visibility: "visible",
				observed_at: "2026-07-13T12:00:00.000Z",
				data: { last_seen_epoch: 1_784_000_000 },
			},
			governance: {
				visibility: "visible",
				observed_at: "2026-07-13T12:00:01.000Z",
				data: { light: "green", tokens_spent: 42 },
			},
			identity: { visibility: "visible", data: { autonomy: "auto", lane: "admin" } },
			lease: {
				visibility: "visible",
				data: { task_id: 712, lease_expires_at: "2026-07-13T12:30:00.000Z", fence: 4 },
			},
		};
		const result = flattenRosterItem(row);
		assert.equal(result.host, ".202");
		assert.equal(result.status, "working");
		assert.equal(result.heartbeat_state, "running");
		assert.equal(result.channel_lock_state, "held");
		assert.equal(result.workers_active, 2);
		assert.equal(result.observed_at, "2026-07-13T12:00:03.000Z");
		assert.deepEqual(result.sources?.fleet, {
			visibility: "visible",
			observed_at: "2026-07-13T12:00:02.000Z",
		});
	});

	it("keeps unavailable distinct from an absent source", () => {
		const result = flattenRosterItem({
			handle: "derek",
			fleet: absent,
			heartbeat: absent,
			registry: {
				visibility: "visible",
				observed_at: "2026-07-13T12:00:00.000Z",
				data: { host: "mc34", last_seen_epoch: 1_784_000_000 },
			},
			governance: absent,
			identity: { visibility: "unavailable", data: null },
			lease: { visibility: "unavailable", data: null },
		});
		assert.equal(result.host, "mc34");
		assert.equal(result.sources?.identity.visibility, "unavailable");
		assert.equal(result.status, null);
	});
});
