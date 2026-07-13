import type { AvailabilitySnapshot } from "$lib/api/types";

type AvailabilityItem = AvailabilitySnapshot["items"][number];

function series(
	now: number,
	values: readonly (number | null)[],
	cadenceS = 30,
): AvailabilityItem["points"] {
	return values.map((latency, index) => ({
		ts: new Date(now - (values.length - 1 - index) * cadenceS * 1000).toISOString(),
		ok: latency !== null,
		latency_ms: latency,
	}));
}

function item(
	now: number,
	input: Pick<
		AvailabilityItem,
		| "subject"
		| "service"
		| "host"
		| "state"
		| "p50_latency_ms"
		| "p95_latency_ms"
		| "degraded_threshold_ms"
		| "uptime_pct"
		| "coverage_pct"
	> & {
		values: readonly (number | null)[];
		windowS?: number;
		outageSince?: string | null;
		gap?: AvailabilityItem["largest_gap"];
	},
): AvailabilityItem {
	const windowS = input.windowS ?? 30 * 86_400;
	const cadenceS = 30;
	const observed = Math.max(1, Math.round((windowS / cadenceS) * (input.coverage_pct / 100)));
	return {
		subject: input.subject,
		service: input.service,
		host: input.host,
		state: input.state,
		p50_latency_ms: input.p50_latency_ms,
		p95_latency_ms: input.p95_latency_ms,
		degraded_threshold_ms: input.degraded_threshold_ms,
		uptime_pct: input.uptime_pct,
		coverage_pct: input.coverage_pct,
		window_s: windowS,
		cadence_s: cadenceS,
		observed_probes: observed,
		expected_probes: Math.round(windowS / cadenceS),
		invalid_probes: 0,
		source_error: null,
		last_probe_at: new Date(now).toISOString(),
		outage_since: input.outageSince ?? null,
		largest_gap: input.gap ?? null,
		points: series(now, input.values),
	};
}

/** Mock parity for the Hosts availability panel: every tri-state and honesty treatment is visible. */
export function mockAvailability(now = Date.now()): AvailabilitySnapshot {
	const gapFrom = new Date(now - 50 * 60_000).toISOString();
	const gapTo = new Date(now - 20 * 60_000).toISOString();
	return {
		schema_version: 1,
		freshness: {
			source: "lake",
			observed_at: new Date(now - 8_000).toISOString(),
			window_s: 30 * 86_400,
		},
		probe_runner: "janet@.202",
		items: [
			item(now, {
				subject: "vps/doorman",
				service: "doorman",
				host: "vps",
				state: "up",
				p50_latency_ms: 41,
				p95_latency_ms: 58,
				degraded_threshold_ms: 500,
				uptime_pct: 99.98,
				coverage_pct: 100,
				values: [44, 41, 43, 39, 45, 42, 40, 41, 39, 43, 41, 42],
			}),
			item(now, {
				subject: ".202/dispatcher",
				service: "dispatcher",
				host: ".202",
				state: "up",
				p50_latency_ms: 12,
				p95_latency_ms: 19,
				degraded_threshold_ms: 250,
				uptime_pct: 99.94,
				coverage_pct: 100,
				values: [13, 12, 14, 11, 12, 13, 12, 11, 13, 12, 12, 13],
			}),
			item(now, {
				subject: ".202/control-plane",
				service: "control-plane",
				host: ".202",
				state: "up",
				p50_latency_ms: 9,
				p95_latency_ms: 14,
				degraded_threshold_ms: 250,
				uptime_pct: 100,
				coverage_pct: 100,
				windowS: 7 * 86_400,
				values: [9, 8, 10, 9, 9, 11, 8, 9, 10, 9, 8, 9],
			}),
			item(now, {
				subject: ".14/tasks",
				service: "tasks app",
				host: ".14",
				state: "up",
				p50_latency_ms: 88,
				p95_latency_ms: 144,
				degraded_threshold_ms: 500,
				uptime_pct: 99.6,
				coverage_pct: 100,
				values: [82, 94, 86, 91, 88, 85, 92, 89, 84, 90, 87, 88],
			}),
			item(now, {
				subject: ".202/matrix-bridge",
				service: "matrix bridge",
				host: ".202",
				state: "degraded",
				p50_latency_ms: 612,
				p95_latency_ms: 881,
				degraded_threshold_ms: 500,
				uptime_pct: 98.2,
				coverage_pct: 96,
				gap: { from: gapFrom, to: gapTo },
				values: [241, 288, 310, null, null, 462, 518, 590, 641, 712, 805, 881],
			}),
			item(now, {
				subject: ".15/library",
				service: "library",
				host: ".15",
				state: "down",
				p50_latency_ms: 34,
				p95_latency_ms: 52,
				degraded_threshold_ms: 250,
				uptime_pct: 99.1,
				coverage_pct: 99.4,
				outageSince: new Date(now - 6 * 60_000).toISOString(),
				values: [35, 32, 34, 36, 33, 38, 34, 35, 33, null, null, null],
			}),
		],
	};
}
