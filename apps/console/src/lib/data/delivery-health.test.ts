import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deriveDeliveryLineHealth } from "./delivery-health.ts";
import type { DeliveryReceiptView } from "./signals.ts";

const NOW = Date.parse("2026-07-13T20:00:00.000Z");

function receipt(
	minutesAgo: number,
	status: "delivered" | "failed",
	tier = "interrupt",
): DeliveryReceiptView {
	return {
		seq: `${minutesAgo}-${status}`,
		ts: new Date(NOW - minutesAgo * 60_000).toISOString(),
		tier,
		signal: tier === "test" ? "delivery.test" : "agent.crashed",
		subject: "carson-2",
		status,
		error: status === "failed" ? "M_FORBIDDEN" : null,
	};
}

describe("deriveDeliveryLineHealth", () => {
	it("is unconfigured when no Matrix target exists", () => {
		const health = deriveDeliveryLineHealth({
			target: null,
			receipts: [],
			matrixSyncOkEpoch: null,
			busObservedAt: null,
			now: NOW,
		});
		assert.equal(health.state, "unconfigured");
	});

	it("requires positive bus, receipt, and Matrix evidence before claiming healthy", () => {
		const health = deriveDeliveryLineHealth({
			target: "@parker:petalcat.dev",
			receipts: [receipt(2, "delivered", "test")],
			matrixSyncOkEpoch: Math.floor((NOW - 15_000) / 1_000),
			busObservedAt: new Date(NOW - 4 * 60_000).toISOString(),
			now: NOW,
		});
		assert.equal(health.state, "unverifiable");
		assert.match(health.summary, /Bus silent 4m/);
	});

	it("cracks after two consecutive failures in ten minutes", () => {
		const health = deriveDeliveryLineHealth({
			target: "@parker:petalcat.dev",
			receipts: [receipt(1, "failed"), receipt(4, "failed"), receipt(20, "delivered")],
			matrixSyncOkEpoch: Math.floor((NOW - 15_000) / 1_000),
			busObservedAt: new Date(NOW - 15_000).toISOString(),
			now: NOW,
		});
		assert.equal(health.state, "failing");
		assert.equal(health.backupInterrupts.length, 2);
		assert.equal(health.flapping, false);
	});

	it("cracks when Matrix sync is more than 120 seconds stale", () => {
		const health = deriveDeliveryLineHealth({
			target: "@parker:petalcat.dev",
			receipts: [receipt(1, "delivered")],
			matrixSyncOkEpoch: Math.floor((NOW - 121_000) / 1_000),
			busObservedAt: new Date(NOW - 15_000).toISOString(),
			now: NOW,
		});
		assert.equal(health.state, "failing");
		assert.match(health.detail, /Matrix sync 2m stale/);
	});

	it("consolidates repeated qualifying failure cycles and damps a recent recovery", () => {
		const health = deriveDeliveryLineHealth({
			target: "@parker:petalcat.dev",
			receipts: [
				receipt(1, "delivered", "test"),
				receipt(3, "failed"),
				receipt(4, "failed"),
				receipt(20, "delivered", "test"),
				receipt(24, "failed"),
				receipt(25, "failed"),
			],
			matrixSyncOkEpoch: Math.floor((NOW - 15_000) / 1_000),
			busObservedAt: new Date(NOW - 15_000).toISOString(),
			now: NOW,
		});
		assert.equal(health.state, "failing");
		assert.equal(health.flapping, true);
		assert.equal(health.cycleCount, 2);
		assert.match(health.detail, /flapping, 2 cycles this hour/);
	});

	it("heals a flapping line after the ten-minute damping interval", () => {
		const health = deriveDeliveryLineHealth({
			target: "@parker:petalcat.dev",
			receipts: [
				receipt(12, "delivered", "test"),
				receipt(14, "failed"),
				receipt(15, "failed"),
				receipt(30, "delivered", "test"),
				receipt(34, "failed"),
				receipt(35, "failed"),
			],
			matrixSyncOkEpoch: Math.floor((NOW - 15_000) / 1_000),
			busObservedAt: new Date(NOW - 15_000).toISOString(),
			now: NOW,
		});
		assert.equal(health.state, "healthy");
	});
});
