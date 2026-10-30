import { describe, expect, it } from "vitest";

import { servicesSummary } from "./services.js";

// Uptime Kuma on 2026-10-30 02:36 UTC: 26 active monitors, 21 up, these 5 down, none pending.
const kuma = {
	up: 21,
	down: [
		{ id: 12, name: "PetalGo" },
		{ id: 52, name: "Bluesky PDS" },
		{ id: 57, name: "BlueMap" },
		{ id: 58, name: "matrix-bot relay (sync)" },
		{ id: 60, name: "Media offsite backup (.15)" },
	],
	pending: 0,
	failedChecks1h: 162,
	failingServices1h: 4,
	stale: false,
};
const KUMA = "https://kuma.petalcat.dev";

describe("services summary", () => {
	it("states the down count once, in the Down figure, not again in the status", () => {
		const summary = servicesSummary(kuma, KUMA);

		expect(summary.status).toBeNull();

		expect(summary.stats).toEqual([
			{ label: "Up", count: 21, alert: false },
			{ label: "Down", count: 5, alert: true },
			{ label: "Pending", count: 0, alert: false },
		]);
	});

	it("links each down monitor and the summary to its Kuma dashboard page", () => {
		const summary = servicesSummary(kuma, KUMA);

		expect(summary.href).toBe("https://kuma.petalcat.dev/dashboard");

		expect(summary.down.map((monitor) => monitor.href)).toEqual([
			"https://kuma.petalcat.dev/dashboard/12",
			"https://kuma.petalcat.dev/dashboard/52",
			"https://kuma.petalcat.dev/dashboard/57",
			"https://kuma.petalcat.dev/dashboard/58",
			"https://kuma.petalcat.dev/dashboard/60",
		]);

		expect(summary.down[0]?.name).toBe("PetalGo");
	});

	it("names down monitors without links when no Kuma URL is configured", () => {
		const summary = servicesSummary(kuma, null);

		expect(summary.href).toBeNull();
		expect(summary.down.map((monitor) => monitor.href)).toEqual([null, null, null, null, null]);
	});

	it("counts failed heartbeats as checks, not as services", () => {
		expect(servicesSummary(kuma, KUMA).recent).toBe(
			"162 failed checks across 4 services in the last hour",
		);
	});

	it("uses singular wording for one failed check on one service", () => {
		expect(servicesSummary({ ...kuma, failedChecks1h: 1, failingServices1h: 1 }, KUMA).recent).toBe(
			"1 failed check across 1 service in the last hour",
		);
	});

	it("says all up when nothing is down or pending", () => {
		const summary = servicesSummary(
			{ ...kuma, down: [], failedChecks1h: 0, failingServices1h: 0 },
			KUMA,
		);

		expect(summary.status).toBe("All up");
		expect(summary.recent).toBeNull();
	});

	it("does not vouch for health it could not read", () => {
		expect(servicesSummary({ ...kuma, stale: true }, KUMA).status).toBe("Stale");
	});
});
