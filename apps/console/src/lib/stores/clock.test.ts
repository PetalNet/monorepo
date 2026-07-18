import { afterEach, describe, expect, it } from "vitest";

import { clockNow } from "./clock.svelte.ts";

type TemporalHost = { Temporal?: unknown };

describe("shared clock", () => {
	afterEach(() => {
		delete (globalThis as TemporalHost).Temporal;
	});

	it("reports the current wall-clock time as epoch milliseconds", () => {
		const before = Date.now();
		const now = clockNow();
		const after = Date.now();

		expect(Number.isFinite(now)).toBe(true);
		expect(now).toBeGreaterThanOrEqual(before);
		expect(now).toBeLessThanOrEqual(after);
	});

	it("advances as real time passes", async () => {
		const first = clockNow();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(clockNow()).toBeGreaterThan(first);
	});

	it("prefers a native Temporal clock over Date.now when the host provides one", () => {
		const frozen = 1_784_000_000_000;
		(globalThis as TemporalHost).Temporal = {
			Now: { instant: () => ({ epochMilliseconds: frozen }) },
		};

		expect(clockNow()).toBe(frozen);
	});
});
