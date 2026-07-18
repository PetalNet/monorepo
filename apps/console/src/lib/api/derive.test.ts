import { describe, expect, it } from "vitest";

import {
	consoleHealthBusAgeS,
	flattenRosterItem,
	signalSeverityLabel,
	type JoinedRosterItem,
} from "./derive.ts";

describe("signalSeverityLabel", () => {
	it("maps every signal severity to its canonical operator grade", () => {
		expect((["p0", "danger", "warn", "info", "debug"] as const).map(signalSeverityLabel)).toEqual([
			"P0",
			"P1",
			"P2",
			"P3",
			"feed only",
		]);
	});
});

describe("consoleHealthBusAgeS", () => {
	it("requires explicit bridge proof and measures its clock", () => {
		const now = Date.parse("2026-07-13T12:00:30.000Z");
		expect(
			consoleHealthBusAgeS({ lake: "ok", seq_head: 9, bridges: [], ws_clients: 3 }, now),
		).toBeNull();
		expect(
			consoleHealthBusAgeS(
				{
					lake: "ok",
					seq_head: 9,
					bridges: [{ observed_at: "2026-07-13T12:00:22.000Z" }],
				},
				now,
			),
		).toBe(8);
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
		expect(result.host).toBe(".202");
		expect(result.status).toBe("working");
		expect(result.heartbeat_state).toBe("running");
		expect(result.channel_lock_state).toBe("held");
		expect(result.workers_active).toBe(2);
		expect(result.observed_at).toBe("2026-07-13T12:00:03.000Z");
		expect(result.sources?.fleet).toEqual({
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
		expect(result.host).toBe("mc34");
		expect(result.sources?.identity.visibility).toBe("unavailable");
		expect(result.status).toBeNull();
	});
});
