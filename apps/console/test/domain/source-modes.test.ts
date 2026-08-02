import { describe, expect, it, vi } from "vitest";

import type { Emission } from "../../src/lib/server/domain/emission.ts";
import { SignalSourceModes } from "../../src/lib/server/domain/signals/source-modes.ts";

function sourceModeStore() {
	const pending = new Map<string, Record<string, unknown>>();
	const saved = {
		source_service: "timescaledb-ha-test",
		mode: "development" as const,
		note: "test-container work",
		updated_at: "2026-07-13T16:00:00.000Z",
		updated_by: "parker",
	};
	const tx = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
		const statement = strings.join(" ");
		if (statement.includes("pg_advisory_xact_lock")) return [];
		if (statement.includes("select mode from signal_source_modes")) return [{ mode: "normal" }];
		if (statement.includes("insert into signal_source_modes")) return [saved];
		if (statement.includes("insert into signal_source_mode_outbox")) {
			pending.set(String(values[0]), { id: values[0], ...saved });
			return [];
		}
		return [];
	});
	const sql = vi.fn(async (strings: TemplateStringsArray) => {
		const statement = strings.join(" ");
		if (statement.includes("delete from signal_source_mode_outbox")) {
			pending.clear();
			return [];
		}
		if (statement.includes("from signal_source_mode_outbox")) return [...pending.values()];
		return [];
	});
	Object.assign(sql, { begin: async (run: (transaction: typeof tx) => unknown) => run(tx) });
	return { sql: sql as never, pending, tx };
}

describe("signal source development modes", () => {
	it("persists the selected mode and publishes the audited state change", async () => {
		const { sql, pending, tx } = sourceModeStore();
		const emitted: Emission[] = [];
		const modes = new SignalSourceModes(sql, async (emission) => {
			emitted.push(emission);
			return { ok: true, seq: 42 };
		});

		await expect(
			modes.set("parker", "timescaledb-ha-test", "development", "test-container work"),
		).resolves.toMatchObject({
			source_service: "timescaledb-ha-test",
			mode: "development",
			previous_mode: "normal",
			updated_by: "parker",
		});
		expect(emitted).toContainEqual(
			expect.objectContaining({
				type: "signal.source_mode_changed",
				scope: "fleet",
				dimensions: expect.objectContaining({
					source_service: "timescaledb-ha-test",
					mode: "development",
					alerts_muted: true,
					updated_by: "parker",
				}),
			}),
		);
		expect(pending.size).toBe(0);
		expect(tx.mock.calls[0]?.[0].join(" ")).toContain("pg_advisory_xact_lock");
		expect(tx.mock.calls[1]?.[0].join(" ")).toContain("select mode from signal_source_modes");
	});

	it("reconciles a committed change when the first event append fails", async () => {
		const { sql, pending } = sourceModeStore();
		let attempts = 0;
		const modes = new SignalSourceModes(sql, async () => ({
			ok: ++attempts > 1,
			...(attempts > 1 ? { seq: 42 } : { code: "append_failed" }),
		}));

		await expect(
			modes.set("parker", "timescaledb-ha-test", "development", "test-container work"),
		).resolves.toMatchObject({ mode: "development" });
		expect(pending.size).toBe(1);
		await expect(modes.reconcilePending()).resolves.toBe(1);
		expect(pending.size).toBe(0);
	});
});
