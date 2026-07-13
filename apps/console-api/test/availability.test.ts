import { describe, expect, it } from "vitest";

import {
	assembleAvailability,
	type AvailabilityPoint,
	type ProbeSummary,
} from "../src/availability/service.ts";

const NOW = Date.parse("2026-07-13T18:00:00.000Z");

function summary(over: Partial<ProbeSummary> = {}): ProbeSummary {
	return {
		subject: ".202/doorman",
		service: "doorman",
		host: ".202",
		observed_probes: 4,
		successful_probes: 4,
		invalid_probes: 0,
		p50_latency_ms: 41.04,
		p95_latency_ms: 45,
		cadence_s: 30,
		threshold_ms: 500,
		first_probe_at: "2026-07-13T17:58:30.000Z",
		last_probe_at: "2026-07-13T18:00:00.000Z",
		largest_gap_from: "2026-07-13T17:59:00.000Z",
		largest_gap_to: "2026-07-13T17:59:30.000Z",
		probe_runner: "janet",
		...over,
	};
}

function point(ts: string, ok: boolean, latency = 40): AvailabilityPoint {
	return { ts, ok, latency_ms: ok ? latency : null };
}

describe("services availability derivation", () => {
	it("returns an observed uptime, p50, and complete coverage without inventing gaps", () => {
		const probes = [
			point("2026-07-13T17:58:30.000Z", true),
			point("2026-07-13T17:59:00.000Z", true),
			point("2026-07-13T17:59:30.000Z", true),
			point("2026-07-13T18:00:00.000Z", true),
		];
		const snapshot = assembleAvailability(
			[summary()],
			new Map([[".202/doorman", probes]]),
			[],
			90,
			NOW,
		);
		expect(snapshot.probe_runner).toBe("janet");
		expect(snapshot.items[0]).toMatchObject({
			state: "up",
			p50_latency_ms: 41,
			p95_latency_ms: 45,
			degraded_threshold_ms: 500,
			uptime_pct: 100,
			coverage_pct: 100,
			largest_gap: null,
		});
	});

	it("keeps missing probes out of uptime and exposes the gap through coverage", () => {
		const snapshot = assembleAvailability(
			[
				summary({
					observed_probes: 3,
					successful_probes: 2,
					first_probe_at: "2026-07-13T17:57:30.000Z",
					largest_gap_from: "2026-07-13T17:58:00.000Z",
					largest_gap_to: "2026-07-13T17:59:30.000Z",
				}),
			],
			new Map(),
			[],
			150,
			NOW,
		);
		expect(snapshot.items[0]).toMatchObject({
			uptime_pct: 66.67,
			coverage_pct: 50,
			largest_gap: {
				from: "2026-07-13T17:58:00.000Z",
				to: "2026-07-13T17:59:30.000Z",
			},
		});
	});

	it("derives degraded from p95 and down from three failures or a fresh down signal", () => {
		const degraded = assembleAvailability(
			[summary({ p95_latency_ms: 612 })],
			new Map(),
			[],
			90,
			NOW,
		);
		expect(degraded.items[0]?.state).toBe("degraded");

		const failed = [
			point("2026-07-13T17:59:00.000Z", false),
			point("2026-07-13T17:59:30.000Z", false),
			point("2026-07-13T18:00:00.000Z", false),
		];
		const down = assembleAvailability(
			[summary({ observed_probes: 3, successful_probes: 0 })],
			new Map([[".202/doorman", failed]]),
			[],
			90,
			NOW,
		);
		expect(down.items[0]).toMatchObject({
			state: "down",
			outage_since: "2026-07-13T17:59:00.000Z",
		});

		const signaled = assembleAvailability(
			[summary()],
			new Map(),
			[
				{
					subject: ".202/doorman",
					service: "doorman",
					host: ".202",
					probe_runner: "janet",
					observed_at: "2026-07-13T17:59:42.000Z",
					last_probe_at: "2026-07-13T18:00:00.000Z",
					last_probe_result: true,
					last_signal_type: "service.down",
					last_signal_at: "2026-07-13T17:59:42.000Z",
				},
			],
			90,
			NOW,
		);
		expect(signaled.items[0]?.outage_since).toBe("2026-07-13T17:59:42.000Z");
	});

	it("marks a probe stream down after three missed cadences and caps the sparkline at 60", () => {
		const points = Array.from({ length: 75 }, (_, index) =>
			point(new Date(NOW - (74 - index) * 30_000).toISOString(), true, index),
		);
		const snapshot = assembleAvailability(
			[
				summary({
					observed_probes: 75,
					successful_probes: 75,
					first_probe_at: points[0]!.ts,
					last_probe_at: "2026-07-13T17:58:29.000Z",
				}),
			],
			new Map([[".202/doorman", points]]),
			[],
			74 * 30,
			NOW,
		);
		expect(snapshot.items[0]?.state).toBe("down");
		expect(snapshot.items[0]?.points).toHaveLength(60);
	});

	it("retains a known service outside the reporting window and renders its silence down", () => {
		const snapshot = assembleAvailability(
			[],
			new Map(),
			[
				{
					subject: ".14/retained",
					service: "retained",
					host: ".14",
					probe_runner: "janet",
					observed_at: "2026-06-01T12:00:00.000Z",
					last_probe_at: "2026-06-01T12:00:00.000Z",
					last_probe_result: true,
					last_signal_type: null,
					last_signal_at: null,
				},
			],
			30 * 86_400,
			NOW,
		);
		expect(snapshot.items[0]).toMatchObject({
			service: "retained",
			state: "down",
			coverage_pct: 0,
			uptime_pct: null,
			outage_since: "2026-06-01T12:00:30.000Z",
		});
	});

	it("surfaces malformed probe results instead of dropping them", () => {
		const snapshot = assembleAvailability(
			[summary({ observed_probes: 1, successful_probes: 0, invalid_probes: 1 })],
			new Map(),
			[
				{
					subject: ".202/doorman",
					service: "doorman",
					host: ".202",
					probe_runner: "janet",
					observed_at: "2026-07-13T18:00:00.000Z",
					last_probe_at: "2026-07-13T18:00:00.000Z",
					last_probe_result: "unknown",
					last_signal_type: null,
					last_signal_at: null,
				},
			],
			90,
			NOW,
		);
		expect(snapshot.items[0]).toMatchObject({
			state: "down",
			invalid_probes: 1,
			source_error: "1 probe result is unreadable in this window",
			uptime_pct: null,
		});
	});
});
