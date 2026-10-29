import { describe, expect, it } from "vitest";

import { servicesSummary } from "./services.js";

// Uptime Kuma on 2026-10-29: 21 monitors up, 5 down, none pending, 222 failed heartbeats in the hour.
const kuma = {
	up: 21,
	down: 5,
	pending: 0,
	failedChecks1h: 222,
	failingServices1h: 6,
	stale: false,
};

describe("services summary", () => {
	it("names what needs attention in the pill instead of a bare warning", () => {
		expect(servicesSummary(kuma).pill).toEqual({ label: "5 down", tone: "down" });
	});

	it("labels each count and highlights only down", () => {
		expect(servicesSummary(kuma).stats).toEqual([
			{ label: "Up", count: 21, alert: false },
			{ label: "Down", count: 5, alert: true },
			{ label: "Pending", count: 0, alert: false },
		]);
	});

	it("counts failed heartbeats as checks, not as services", () => {
		expect(servicesSummary(kuma).recent).toBe(
			"222 failed checks across 6 services in the last hour",
		);
	});

	it("uses singular wording for one failed check on one service", () => {
		expect(servicesSummary({ ...kuma, failedChecks1h: 1, failingServices1h: 1 }).recent).toBe(
			"1 failed check across 1 service in the last hour",
		);
	});

	it("says all up when nothing is down or pending", () => {
		const summary = servicesSummary({ ...kuma, down: 0, failedChecks1h: 0, failingServices1h: 0 });

		expect(summary.pill).toEqual({ label: "All up", tone: "ok" });
		expect(summary.recent).toBeNull();
	});

	it("does not vouch for health it could not read", () => {
		expect(servicesSummary({ ...kuma, stale: true }).pill).toEqual({
			label: "Stale",
			tone: "warn",
		});
	});
});
