import { describe, expect, it } from "vitest";

import type { TrackerReader, TrackerRow } from "../../src/lib/server/domain/reads/tracker.ts";
import { readWorkSettlement } from "../../src/lib/server/domain/reads/work-settlement.ts";

const NOW = new Date("2026-07-13T18:00:00Z");

function task(id: number, status: "done" | "dropped" | "doing", updatedAt: string) {
	return {
		id,
		kind: "task",
		title: `task ${String(id)}`,
		status,
		priority: 2,
		created_at: "2026-07-01T12:00:00Z",
		updated_at: updatedAt,
		project_name: "console",
	};
}

function settlement(rows: TrackerRow[]) {
	const tracker = { closedTasks: () => rows } as unknown as TrackerReader;
	return readWorkSettlement(tracker, ["project:console"], NOW);
}

describe("work auto-settlement", () => {
	it("keeps done tasks on Work before 24h and files them in history at the boundary", () => {
		const result = settlement([
			task(1, "done", "2026-07-12T18:00:01Z"),
			task(2, "done", "2026-07-12T18:00:00Z"),
			task(3, "doing", "2026-07-10T18:00:00Z"),
		]);

		expect(result.settling.map((item) => item.id)).toEqual([1]);
		expect(result.settling[0]?.settles_at).toBe("2026-07-13T18:00:01.000Z");
		expect(result.settling[0]?.created_at).toBe("2026-07-01T12:00:00.000Z");
		expect(result.history.map((item) => item.id)).toEqual([2]);
		expect([...result.settling, ...result.history].map((item) => item.id).sort()).toEqual([1, 2]);
	});

	it("files dropped work immediately and counts settlements by settlement time", () => {
		const result = settlement([
			task(4, "dropped", "2026-07-13 17:00:00"),
			task(5, "done", "2026-07-06T17:59:59Z"),
			task(6, "done", "2026-07-05T17:59:59Z"),
		]);

		expect(result.history.map((item) => item.id)).toEqual([4, 5, 6]);
		expect(result.settled_this_week).toBe(1);
	});

	it("omits malformed timestamps instead of making a false freshness claim", () => {
		const result = settlement([task(7, "done", "not-a-time")]);
		expect(result.settling).toEqual([]);
		expect(result.history).toEqual([]);
		expect(result.invalid_timestamp_count).toBe(1);
	});
});
