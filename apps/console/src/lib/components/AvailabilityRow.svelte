<script lang="ts">
	import type { AvailabilitySnapshot } from "$lib/api/types";
	import StatusPill from "./StatusPill.svelte";

	type Item = AvailabilitySnapshot["items"][number];

	interface Props {
		item: Item;
	}

	let { item }: Props = $props();
	const tone = $derived(item.state === "up" ? "good" : item.state === "degraded" ? "warn" : "danger");
	const successful = $derived(item.points.filter((point) => point.ok && point.latency_ms !== null));
	const minLatency = $derived(successful.length ? Math.min(...successful.map((point) => point.latency_ms!)) : 0);
	const maxLatency = $derived(successful.length ? Math.max(...successful.map((point) => point.latency_ms!)) : 1);
	const range = $derived(Math.max(1, maxLatency - minLatency));

	function segments(): string[] {
		const output: string[] = [];
		let segment: string[] = [];
		let previousAt: number | null = null;
		item.points.forEach((point, index) => {
			const at = Date.parse(point.ts);
			const hasGap = previousAt !== null && at - previousAt > item.cadence_s * 1500;
			if (!point.ok || point.latency_ms === null || hasGap) {
				if (segment.length) output.push(segment.join(" "));
				segment = [];
			}
			if (point.ok && point.latency_ms !== null) {
				const x = item.points.length <= 1 ? 48 : (index / (item.points.length - 1)) * 96;
				const y = 17 - ((point.latency_ms - minLatency) / range) * 14;
				segment.push(`${x.toFixed(1)},${y.toFixed(1)}`);
			}
			previousAt = at;
		});
		if (segment.length) output.push(segment.join(" "));
		return output;
	}

	function failedX(index: number): number {
		return item.points.length <= 1 ? 48 : (index / (item.points.length - 1)) * 96;
	}

	function windowLabel(seconds: number): string {
		if (seconds <= 25 * 3600) return "24h";
		const days = Math.max(1, Math.round(seconds / 86_400));
		return `${String(days)}d`;
	}

	function percentage(value: number | null): string {
		if (value === null) return "—";
		if (value === 100) return "100%";
		return `${value >= 99 ? value.toFixed(2) : value.toFixed(1)}%`;
	}

	function shortTime(value: string): string {
		return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	}

	const detail = $derived.by(() => {
		if (item.source_error) return item.source_error;
		if (item.state === "down" && item.outage_since)
			return `no response since ${shortTime(item.outage_since)}`;
		if (item.state === "degraded" && item.p95_latency_ms !== null)
			return `p95 ${String(Math.round(item.p95_latency_ms))} ms over ${String(Math.round(item.degraded_threshold_ms))} ms threshold`;
		if (item.largest_gap)
			return `gap ${shortTime(item.largest_gap.from)} to ${shortTime(item.largest_gap.to)} shown`;
		if (item.window_s < 29 * 86_400) return `new check · ${windowLabel(item.window_s)} observed window`;
		return null;
	});
	const accessibleLabel = $derived(
		`${item.service} on ${item.host ?? "unknown host"}: ${item.state}; ` +
			`${item.p50_latency_ms === null ? "latency unavailable" : `${String(Math.round(item.p50_latency_ms))} milliseconds p50`}; ` +
			`${percentage(item.uptime_pct)} uptime over ${windowLabel(item.window_s)}; ${String(item.coverage_pct)}% coverage`,
	);
</script>

<a
	class="availability-row {tone}"
	class:unreadable={item.source_error !== null}
	href="/observability?stat=service.probe&subject={encodeURIComponent(item.subject)}"
	aria-label={accessibleLabel}
>
	<span class="service-name"><b>{item.service}</b><span>{item.host ?? "host unknown"}</span></span>
	<span class="state"><StatusPill {tone} label={item.state} /></span>
	<svg
		class="spark"
		viewBox="0 0 96 20"
		preserveAspectRatio="none"
		role="img"
		aria-label={`${item.service} response latency, latest ${String(item.points.length)} probes`}
	>
		<line class="baseline" x1="0" y1="18" x2="96" y2="18" />
		{#each segments() as points, index (index)}
			<polyline {points} />
		{/each}
		{#each item.points as point, index (point.ts)}
			{#if !point.ok}<circle cx={failedX(index)} cy="18" r="1.5" />{/if}
		{/each}
	</svg>
	<span class="latency">{item.p50_latency_ms === null ? "—" : `${String(Math.round(item.p50_latency_ms))} ms`} <small>p50</small></span>
	<span class="uptime">
		<span class="uptime-value">{percentage(item.uptime_pct)} <i>· {windowLabel(item.window_s)}</i></span>
		{#if item.coverage_pct < 99.95}<span class="coverage">{item.coverage_pct.toFixed(item.coverage_pct % 1 ? 1 : 0)}% coverage</span>{/if}
		{#if detail}<span class="detail">{detail}</span>{/if}
		<span class="math">Show the math.</span>
	</span>
</a>

<style>
	.availability-row {
		display: grid;
		grid-template-columns: minmax(152px, 1.5fr) 104px 112px 88px minmax(176px, 1fr);
		align-items: center;
		gap: var(--s-3);
		min-height: 48px;
		padding: var(--s-1) var(--s-2);
		border-top: 1px solid var(--rule);
		color: var(--text);
		text-decoration: none;
		transition: background-color var(--dur-base) var(--ease-standard);
	}
	.availability-row:hover { background: var(--s2); }
	.availability-row:active { background: var(--s3); }
	.availability-row:focus-visible {
		outline: 2px solid var(--petal);
		outline-offset: 2px;
		position: relative;
	}
	.service-name b {
		display: block;
		font-size: 0.8125rem;
		font-weight: 500;
	}
	.service-name span,
	.coverage,
	.detail,
	.math {
		display: block;
		font-size: 0.6875rem;
		color: var(--text-3);
	}
	.service-name span { font-family: var(--mono); }
	.spark {
		display: block;
		width: 96px;
		height: 20px;
		overflow: visible;
	}
	.spark polyline {
		fill: none;
		stroke: var(--good-dot);
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
		vector-effect: non-scaling-stroke;
		transition: stroke var(--dur-base) var(--ease-standard);
	}
	.warn .spark polyline { stroke: var(--warn-dot); }
	.danger .spark polyline { stroke: var(--danger-dot); }
	.spark .baseline { stroke: var(--rule); stroke-width: 1; vector-effect: non-scaling-stroke; }
	.spark circle { fill: var(--danger-dot); }
	.latency,
	.uptime-value {
		font: 400 0.75rem var(--mono);
		font-variant-numeric: tabular-nums;
		color: var(--text-2);
	}
	.latency small,
	.uptime-value i {
		font: inherit;
		font-style: normal;
		color: var(--text-3);
	}
	.uptime { min-width: 0; }
	.detail {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.down .detail,
	.unreadable .detail { color: var(--danger-text); }
	.warn .detail { color: var(--warn-text); }
	.math {
		color: var(--petal-text);
		font-weight: 500;
		opacity: 0;
		max-height: 0;
		transition: opacity var(--dur-fast) var(--ease-standard);
	}
	.availability-row:hover .math,
	.availability-row:focus-visible .math { opacity: 1; max-height: 1rem; }
	@media (max-width: 900px) {
		.availability-row { grid-template-columns: minmax(136px, 1fr) 104px 96px minmax(148px, 1fr); }
		.latency { display: none; }
	}
	@media (max-width: 640px) {
		.availability-row {
			grid-template-columns: minmax(0, 1fr) auto;
			gap: var(--s-1) var(--s-2);
			padding: var(--s-2);
			min-height: 64px;
		}
		.service-name { grid-column: 1; grid-row: 1; min-width: 0; }
		.state { grid-column: 2; grid-row: 1; }
		.spark { grid-column: 1; grid-row: 2; }
		.uptime { display: contents; }
		.uptime-value { grid-column: 2; grid-row: 2; text-align: right; }
		.coverage,
		.detail {
			grid-column: 1 / -1;
			max-width: none;
			text-align: right;
		}
		.math { display: none; }
	}
	@media (prefers-reduced-motion: reduce) {
		.availability-row,
		.spark polyline,
		.math { transition: none; }
	}
</style>
