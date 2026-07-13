import { describe, expect, it, vi } from "vitest";

import type { Sql } from "../src/db/pool.ts";
import type { Emission } from "../src/emission.ts";
import { SignalStormDetector } from "../src/signals/storm.ts";

describe("signal-storm detection", () => {
	it("uses bus globs, owner scopes, and the strict 60-event threshold", async () => {
		let count = 60;
		const sql = (async (strings: TemplateStringsArray) => {
			const statement = strings.join("?");
			if (statement.includes("expires_at")) return [];
			if (statement.includes("from current_state"))
				return [
					{
						subject: "parker:citeseer.*",
						scope: "user:parker",
						state: { schema_version: 1, pattern: "citeseer.*", tier: "feed", owner: "parker" },
					},
				];
			return [
				{
					type: "citeseer.fetch.done",
					scope: "fleet",
					severity: "info",
					source_service: "citeseer",
					subject: "paper",
					n: String(count),
				},
				{
					type: "citeseer.fetch.done",
					scope: "restricted:other-owner",
					severity: "info",
					source_service: "citeseer",
					subject: "private-paper",
					n: "100",
				},
			];
		}) as unknown as Sql;
		const emitted: Emission[] = [];
		const emit = vi.fn(async (emission: Emission) => {
			emitted.push(emission);
			return { ok: true };
		});
		const detector = new SignalStormDetector(
			sql,
			emit,
			() => new Date("2026-07-13T14:03:00Z"),
			async () => ["fleet"],
		);
		const incoming = {
			schema_version: 1,
			id: "58a895f4-9494-40f8-907e-b698691c4192",
			type: "citeseer.fetch.done",
			ts: "2026-07-13T14:03:00Z",
			source: { service: "citeseer" },
			subject: "paper",
			severity: "info",
			scope: "fleet",
		} satisfies Emission;

		await detector.observe(incoming);
		expect(emit).not.toHaveBeenCalled();
		count += 1;
		await detector.observe(incoming);
		expect(emitted).toHaveLength(1);
		expect(emitted[0]?.meta?.["entity"]).toMatchObject({
			tier: "digest",
			updated_by: "system:bus",
			storm: { active: true, event_count: 61, threshold: 60, previous_tier: "feed" },
		});
	});
});
