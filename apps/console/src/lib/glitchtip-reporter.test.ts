import { describe, expect, it } from "vitest";

import { createCaughtFailureReporter, type SanitizedCaughtFailure } from "./glitchtip-reporter.ts";

describe("caught GlitchTip failure reporting", () => {
	it("sends only sanitized endpoint, surface, and exception-class context", () => {
		const captured: Array<{ error: Error; context: SanitizedCaughtFailure }> = [];
		const report = createCaughtFailureReporter(
			(error, context) => captured.push({ error, context }),
			{ enabled: true, now: () => 1_000 },
		);
		const upstream = new TypeError(
			"secret response for user janet from /box-updates/petal-202/raw?token=private",
		);

		expect(report(upstream, { surface: "updates", endpoint: "/box-updates/:box_id/raw" })).toBe(
			true,
		);
		expect(captured[0]?.context).toEqual({
			surface: "updates",
			endpoint: "/box-updates/:box_id/raw",
			errorClass: "TypeError",
		});
		expect(captured[0]?.error.name).toBe("TypeError");
		expect(captured[0]?.error.message).toBe("Console read failed: /box-updates/:box_id/raw");
		expect(captured[0]?.error.stack ?? "").toMatch(/glitchtip-reporter\.test\.ts/);
		expect(captured[0]?.error.stack ?? "").not.toMatch(/janet|token=private|petal-202/);
	});

	it("deduplicates by surface, endpoint, and class for one minute", () => {
		let clock = 2_000;
		const captured: SanitizedCaughtFailure[] = [];
		const report = createCaughtFailureReporter((_error, context) => captured.push(context), {
			enabled: true,
			now: () => clock,
		});
		const context = { surface: "network", endpoint: "/edge/sessions" } as const;

		expect(report(new Error("first"), context)).toBe(true);
		expect(report(new Error("second"), context)).toBe(false);
		expect(report(new TypeError("different class"), context)).toBe(true);
		expect(report(new Error("different surface"), { ...context, surface: "cockpit" })).toBe(true);
		clock += 60_000;
		expect(report(new Error("window elapsed"), context)).toBe(true);
		expect(captured.length).toBe(4);
	});

	it("is inert when GlitchTip is disabled", () => {
		let calls = 0;
		const report = createCaughtFailureReporter(() => calls++, { enabled: false });

		expect(report(new Error("ignored"), { surface: "cockpit", endpoint: "/me" })).toBe(false);
		expect(calls).toBe(0);
	});
});
