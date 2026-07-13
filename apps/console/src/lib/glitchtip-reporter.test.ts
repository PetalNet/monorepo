import assert from "node:assert/strict";
import { describe, it } from "node:test";

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

		assert.equal(
			report(upstream, { surface: "updates", endpoint: "/box-updates/:box_id/raw" }),
			true,
		);
		assert.deepEqual(captured[0]?.context, {
			surface: "updates",
			endpoint: "/box-updates/:box_id/raw",
			errorClass: "TypeError",
		});
		assert.equal(captured[0]?.error.name, "TypeError");
		assert.equal(captured[0]?.error.message, "Console read failed: /box-updates/:box_id/raw");
		assert.match(captured[0]?.error.stack ?? "", /glitchtip-reporter\.test\.ts/);
		assert.doesNotMatch(captured[0]?.error.stack ?? "", /janet|token=private|petal-202/);
	});

	it("deduplicates by surface, endpoint, and class for one minute", () => {
		let clock = 2_000;
		const captured: SanitizedCaughtFailure[] = [];
		const report = createCaughtFailureReporter((_error, context) => captured.push(context), {
			enabled: true,
			now: () => clock,
		});
		const context = { surface: "network", endpoint: "/edge/sessions" } as const;

		assert.equal(report(new Error("first"), context), true);
		assert.equal(report(new Error("second"), context), false);
		assert.equal(report(new TypeError("different class"), context), true);
		assert.equal(report(new Error("different surface"), { ...context, surface: "cockpit" }), true);
		clock += 60_000;
		assert.equal(report(new Error("window elapsed"), context), true);
		assert.equal(captured.length, 4);
	});

	it("is inert when GlitchTip is disabled", () => {
		let calls = 0;
		const report = createCaughtFailureReporter(() => calls++, { enabled: false });

		assert.equal(report(new Error("ignored"), { surface: "cockpit", endpoint: "/me" }), false);
		assert.equal(calls, 0);
	});
});
