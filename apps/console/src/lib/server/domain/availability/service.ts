import { Effect } from "effect";

import type { Sql } from "../db/pool.ts";
import { withScopes } from "../db/pool.ts";

export type AvailabilityState = "up" | "degraded" | "down";

export interface AvailabilityPoint {
	ts: string;
	ok: boolean;
	latency_ms: number | null;
}

export interface AvailabilityItem {
	subject: string;
	service: string;
	host: string | null;
	state: AvailabilityState;
	p50_latency_ms: number | null;
	p95_latency_ms: number | null;
	degraded_threshold_ms: number;
	uptime_pct: number | null;
	coverage_pct: number;
	window_s: number;
	cadence_s: number;
	observed_probes: number;
	expected_probes: number;
	invalid_probes: number;
	source_error: string | null;
	last_probe_at: string | null;
	outage_since: string | null;
	largest_gap: { from: string; to: string } | null;
	points: AvailabilityPoint[];
}

export interface AvailabilitySnapshot {
	schema_version: 1;
	freshness: {
		source: "lake";
		observed_at: string | null;
		window_s: number;
	};
	probe_runner: string | null;
	items: AvailabilityItem[];
}

export interface ProbeSummary {
	subject: string;
	service: string;
	host: string | null;
	observed_probes: number;
	successful_probes: number;
	invalid_probes: number;
	p50_latency_ms: number | null;
	p95_latency_ms: number | null;
	cadence_s: number | null;
	threshold_ms: number | null;
	first_probe_at: string;
	last_probe_at: string;
	largest_gap_from: string | null;
	largest_gap_to: string | null;
	probe_runner: string | null;
}

export interface KnownService {
	subject: string;
	service: string | null;
	host: string | null;
	probe_runner: string | null;
	observed_at: string;
	last_probe_at: string | null;
	last_probe_result: unknown;
	last_signal_type: "service.down" | "service.up" | null;
	last_signal_at: string | null;
}

const DEFAULT_CADENCE_S = 30;
const DEFAULT_DEGRADED_THRESHOLD_MS = 500;

function iso(value: string | Date): string {
	return typeof value === "string" ? new Date(value).toISOString() : value.toISOString();
}

function rounded(value: number, digits = 2): number {
	const scale = 10 ** digits;
	return Math.round(value * scale) / scale;
}

function trailingOutage(points: readonly AvailabilityPoint[]): string | null {
	let start: string | null = null;
	for (let index = points.length - 1; index >= 0; index -= 1) {
		const point = points[index];
		if (point.ok) break;
		start = point.ts;
	}
	return start;
}

function serviceFromSubject(subject: string): string {
	const slash = subject.indexOf("/");
	return slash >= 0 && slash < subject.length - 1 ? subject.slice(slash + 1) : subject;
}

function hostFromSubject(subject: string): string | null {
	const slash = subject.indexOf("/");
	return slash > 0 ? subject.slice(0, slash) : null;
}

function isProbeResult(value: unknown): boolean {
	return (
		typeof value === "boolean" ||
		(typeof value === "string" &&
			["true", "false", "1", "0", "up", "down", "ok", "failed"].includes(value.toLowerCase())) ||
		value === 0 ||
		value === 1
	);
}

/**
 * @public Pure availability derivation for contract tests and replay tooling.
 *
 * Availability is a derivation over observed facts. Uptime never substitutes expected probes for
 * missing ones; coverage reports those missing observations separately. A silent probe stream is
 * down only after three contracted cadences have elapsed, matching the Hosts surface rule.
 */
export function assembleAvailability(
	summaries: readonly ProbeSummary[],
	pointsBySubject: ReadonlyMap<string, readonly AvailabilityPoint[]>,
	knownServices: readonly KnownService[],
	requestedWindowS: number,
	nowMs: number,
): AvailabilitySnapshot {
	const summaryBySubject = new Map(summaries.map((summary) => [summary.subject, summary]));
	const knownBySubject = new Map(knownServices.map((service) => [service.subject, service]));
	const subjects = new Set([...summaryBySubject.keys(), ...knownBySubject.keys()]);
	let freshest: string | null = null;
	let runner: string | null = null;

	const items = [...subjects].toSorted().map((subject): AvailabilityItem => {
		const summary = summaryBySubject.get(subject);
		const known = knownBySubject.get(subject);
		const cadenceS = Math.max(1, Math.round(summary?.cadence_s ?? DEFAULT_CADENCE_S));
		const thresholdMs = Math.max(1, summary?.threshold_ms ?? DEFAULT_DEGRADED_THRESHOLD_MS);
		const rawPoints = [...(pointsBySubject.get(subject) ?? [])].toSorted(
			(left, right) => Date.parse(left.ts) - Date.parse(right.ts),
		);
		const points = rawPoints.slice(-60);
		// Do not infer that a check is new merely because the first visible probe is recent. That can
		// also mean the source was silent. Until a producer contracts an explicit check-start fact,
		// coverage is measured against the whole requested window.
		const effectiveWindowS = Math.max(cadenceS, requestedWindowS);
		const expected = Math.max(1, Math.floor(effectiveWindowS / cadenceS) + 1);
		const observed = summary?.observed_probes ?? 0;
		const invalid = summary?.invalid_probes ?? 0;
		const valid = Math.max(0, observed - invalid);
		const coverage = rounded(Math.min(100, (observed / expected) * 100));
		const uptime = valid > 0 ? rounded(((summary?.successful_probes ?? 0) / valid) * 100) : null;
		const lastProbeAt = summary?.last_probe_at ?? known?.last_probe_at ?? null;
		const lastProbeMs = lastProbeAt ? Date.parse(lastProbeAt) : Number.NEGATIVE_INFINITY;
		const missedThree = nowMs - lastProbeMs >= cadenceS * 3 * 1000;
		const lastThree = points.slice(-3);
		const threeFailed = lastThree.length === 3 && lastThree.every((point) => !point.ok);
		const signalDown = known?.last_signal_type === "service.down";
		const latestProbeUnreadable = Boolean(
			known?.last_probe_at && !isProbeResult(known.last_probe_result),
		);
		const sourceError =
			invalid > 0
				? `${String(invalid)} probe result${invalid === 1 ? " is" : "s are"} unreadable in this window`
				: latestProbeUnreadable
					? "latest probe result is unreadable"
					: null;
		const unreadableOnly = observed > 0 && valid === 0;
		const state: AvailabilityState =
			signalDown || threeFailed || missedThree || unreadableOnly
				? "down"
				: (summary?.p95_latency_ms ?? 0) > thresholdMs
					? "degraded"
					: "up";

		let outageSince = state === "down" ? trailingOutage(points) : null;
		if (state === "down" && signalDown && known.last_signal_at)
			outageSince = iso(known.last_signal_at);
		if (state === "down" && !outageSince && lastProbeAt)
			outageSince = new Date(lastProbeMs + cadenceS * 1000).toISOString();

		let gapFrom = summary?.largest_gap_from ? iso(summary.largest_gap_from) : null;
		let gapTo = summary?.largest_gap_to ? iso(summary.largest_gap_to) : null;
		const historicGapS = gapFrom && gapTo ? (Date.parse(gapTo) - Date.parse(gapFrom)) / 1000 : 0;
		const tailGapS = summary ? (nowMs - lastProbeMs) / 1000 : 0;
		if (summary && tailGapS > historicGapS && tailGapS > cadenceS * 1.5) {
			gapFrom = iso(summary.last_probe_at);
			gapTo = new Date(nowMs).toISOString();
		}
		const largestGap =
			gapFrom && gapTo && (Date.parse(gapTo) - Date.parse(gapFrom)) / 1000 > cadenceS * 1.5
				? { from: gapFrom, to: gapTo }
				: null;

		const observedAt = summary?.last_probe_at ?? known?.observed_at ?? null;
		if (observedAt && (!freshest || Date.parse(observedAt) > Date.parse(freshest))) {
			freshest = iso(observedAt);
			runner = summary?.probe_runner ?? known?.probe_runner ?? runner;
		}
		return {
			subject,
			service: summary?.service ?? known?.service ?? serviceFromSubject(subject),
			host: summary?.host ?? known?.host ?? hostFromSubject(subject),
			state,
			p50_latency_ms: summary?.p50_latency_ms == null ? null : rounded(summary.p50_latency_ms, 1),
			p95_latency_ms: summary?.p95_latency_ms == null ? null : rounded(summary.p95_latency_ms, 1),
			degraded_threshold_ms: thresholdMs,
			uptime_pct: uptime,
			coverage_pct: coverage,
			window_s: effectiveWindowS,
			cadence_s: cadenceS,
			observed_probes: observed,
			expected_probes: expected,
			invalid_probes: invalid,
			source_error: sourceError,
			last_probe_at: lastProbeAt ? iso(lastProbeAt) : null,
			outage_since: outageSince,
			largest_gap: largestGap,
			points,
		};
	});

	return {
		schema_version: 1,
		freshness: { source: "lake", observed_at: freshest, window_s: requestedWindowS },
		probe_runner: runner,
		items,
	};
}

interface SummaryRow {
	subject: string;
	service: string;
	host: string | null;
	observed_probes: number | string;
	successful_probes: number | string;
	invalid_probes: number | string;
	p50_latency_ms: number | string | null;
	p95_latency_ms: number | string | null;
	cadence_s: number | string | null;
	threshold_ms: number | string | null;
	first_probe_at: string | Date;
	last_probe_at: string | Date;
	largest_gap_from: string | Date | null;
	largest_gap_to: string | Date | null;
	probe_runner: string | null;
}

interface PointRow {
	subject: string;
	ts: string | Date;
	ok: boolean;
	latency_ms: number | string | null;
}

interface KnownServiceRow {
	subject: string;
	state: Record<string, unknown>;
	observed_at: string | Date;
}

export function readAvailability(
	app: Sql,
	scopes: readonly string[],
	windowS: number,
	now = new Date(),
): Effect.Effect<AvailabilitySnapshot> {
	// One scoped transaction fans three lake queries into the pure availability derivation. It is a
	// single external edge (`Effect.promise` over the pg transaction); a lake fault is a defect.
	return Effect.promise(() =>
		withScopes(app, scopes, async (tx) => {
			const summaries = await tx<SummaryRow[]>`
			with parsed as (
				select subject, received_at,
					coalesce(nullif(dimensions->>'service', ''),
						case when position('/' in subject) > 0 then split_part(subject, '/', 2) else subject end) as service,
					coalesce(source_host, nullif(dimensions->>'host', ''),
						case when position('/' in subject) > 0 then split_part(subject, '/', 1) else null end) as host,
					case
						when lower(coalesce(dimensions->>'ok', measures->>'ok', '')) in ('true', '1', 'up', 'ok') then true
						when lower(coalesce(dimensions->>'ok', measures->>'ok', '')) in ('false', '0', 'down', 'failed') then false
						else null
					end as ok,
					case when jsonb_typeof(measures->'latency_ms') = 'number'
						then (measures->>'latency_ms')::double precision else null end as latency_ms,
					case when jsonb_typeof(measures->'cadence_s') = 'number'
						then (measures->>'cadence_s')::double precision
						when coalesce(dimensions->>'cadence_s', '') ~ '^[0-9]+(\\.[0-9]+)?$'
						then (dimensions->>'cadence_s')::double precision else null end as cadence_s,
					case when jsonb_typeof(measures->'degraded_threshold_ms') = 'number'
						then (measures->>'degraded_threshold_ms')::double precision
						when coalesce(dimensions->>'degraded_threshold_ms', '') ~ '^[0-9]+(\\.[0-9]+)?$'
						then (dimensions->>'degraded_threshold_ms')::double precision else null end as threshold_ms,
					coalesce(source_agent, source_service) as probe_runner
				from lake_events
				where type = 'service.probe'
					and received_at >= ${now}::timestamptz - (${windowS} * interval '1 second')
			), samples as (
				select *, lag(received_at) over (partition by subject order by received_at) as previous_at
				from parsed
			)
			select subject,
				(array_agg(service order by received_at desc))[1] as service,
				(array_agg(host order by received_at desc) filter (where host is not null))[1] as host,
				count(*)::int as observed_probes,
				count(*) filter (where ok is null)::int as invalid_probes,
				count(*) filter (where ok)::int as successful_probes,
				percentile_cont(0.5) within group (order by latency_ms)
					filter (where ok and latency_ms is not null) as p50_latency_ms,
				percentile_cont(0.95) within group (order by latency_ms)
					filter (where ok and latency_ms is not null) as p95_latency_ms,
				(array_agg(cadence_s order by received_at desc) filter (where cadence_s is not null))[1] as cadence_s,
				(array_agg(threshold_ms order by received_at desc) filter (where threshold_ms is not null))[1] as threshold_ms,
				min(received_at) as first_probe_at, max(received_at) as last_probe_at,
				(array_agg(previous_at order by received_at - previous_at desc nulls last)
					filter (where previous_at is not null))[1] as largest_gap_from,
				(array_agg(received_at order by received_at - previous_at desc nulls last)
					filter (where previous_at is not null))[1] as largest_gap_to,
				(array_agg(probe_runner order by received_at desc) filter (where probe_runner is not null))[1] as probe_runner
			from samples group by subject order by subject`;

			const pointRows = await tx<PointRow[]>`
			with parsed as (
				select subject, received_at as ts,
					case
						when lower(coalesce(dimensions->>'ok', measures->>'ok', '')) in ('true', '1', 'up', 'ok') then true
						when lower(coalesce(dimensions->>'ok', measures->>'ok', '')) in ('false', '0', 'down', 'failed') then false
						else null
					end as ok,
					case when jsonb_typeof(measures->'latency_ms') = 'number'
						then (measures->>'latency_ms')::double precision else null end as latency_ms,
					row_number() over (partition by subject order by received_at desc) as position
				from lake_events where type = 'service.probe'
					and received_at >= ${now}::timestamptz - (${windowS} * interval '1 second')
			)
			select subject, ts, ok, latency_ms from parsed
			where position <= 60 and ok is not null order by subject, ts`;

			const knownRows = await tx<KnownServiceRow[]>`
			select subject, state, observed_at from current_state
			where kind = 'availability' order by subject`;

			const normalizedSummaries: ProbeSummary[] = summaries.map((row) => ({
				...row,
				observed_probes: Number(row.observed_probes),
				successful_probes: Number(row.successful_probes),
				invalid_probes: Number(row.invalid_probes),
				p50_latency_ms: row.p50_latency_ms == null ? null : Number(row.p50_latency_ms),
				p95_latency_ms: row.p95_latency_ms == null ? null : Number(row.p95_latency_ms),
				cadence_s: row.cadence_s == null ? null : Number(row.cadence_s),
				threshold_ms: row.threshold_ms == null ? null : Number(row.threshold_ms),
				first_probe_at: iso(row.first_probe_at),
				last_probe_at: iso(row.last_probe_at),
				largest_gap_from: row.largest_gap_from ? iso(row.largest_gap_from) : null,
				largest_gap_to: row.largest_gap_to ? iso(row.largest_gap_to) : null,
			}));
			const points = new Map<string, AvailabilityPoint[]>();
			for (const row of pointRows) {
				const list = points.get(row.subject) ?? [];
				list.push({
					ts: iso(row.ts),
					ok: row.ok,
					latency_ms: row.latency_ms == null ? null : Number(row.latency_ms),
				});
				points.set(row.subject, list);
			}
			const knownServices: KnownService[] = knownRows.map((row) => ({
				subject: row.subject,
				service: typeof row.state["service"] === "string" ? row.state["service"] : null,
				host: typeof row.state["host"] === "string" ? row.state["host"] : null,
				probe_runner:
					typeof row.state["probe_runner"] === "string"
						? row.state["probe_runner"]
						: typeof row.state["source"] === "string"
							? row.state["source"]
							: null,
				observed_at: iso(row.observed_at),
				last_probe_at:
					typeof row.state["last_probe_at"] === "string" ? iso(row.state["last_probe_at"]) : null,
				last_probe_result: row.state["last_probe_result"],
				last_signal_type:
					row.state["last_signal_type"] === "service.down" ||
					row.state["last_signal_type"] === "service.up"
						? row.state["last_signal_type"]
						: null,
				last_signal_at:
					typeof row.state["last_signal_at"] === "string" ? iso(row.state["last_signal_at"]) : null,
			}));
			return assembleAvailability(
				normalizedSummaries,
				points,
				knownServices,
				windowS,
				now.getTime(),
			);
		}),
	);
}
