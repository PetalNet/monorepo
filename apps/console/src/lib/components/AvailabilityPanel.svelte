<script lang="ts">
	import type { AvailabilitySnapshot } from "$lib/api/types";
	import { opDef } from "$lib/api/ops";
	import AvailabilityRow from "./AvailabilityRow.svelte";
	import Icon from "./Icon.svelte";
	import OpButton from "./OpButton.svelte";

	interface Props {
		snapshot?: AvailabilitySnapshot;
		loading?: boolean;
		error?: unknown;
		lanes: string[];
		probeRunnerLive?: boolean;
		onrefresh?: () => void;
	}

	let {
		snapshot,
		loading = false,
		error = null,
		lanes,
		probeRunnerLive = false,
		onrefresh,
	}: Props = $props();
	const probe = opDef("host.probe")!;

	function age(value: string | null | undefined): string {
		if (!value) return "freshness unknown";
		const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
		if (seconds < 60) return `${String(seconds)}s ago`;
		if (seconds < 3600) return `${String(Math.round(seconds / 60))}m ago`;
		return `${String(Math.round(seconds / 3600))}h ago`;
	}

	const cadence = $derived.by(() => {
		const values = new Set(snapshot?.items.map((item) => item.cadence_s) ?? []);
		if (values.size !== 1) return "service cadence";
		const seconds = [...values][0];
		return seconds < 60 ? `every ${String(seconds)}s` : `every ${String(Math.round(seconds / 60))}m`;
	});
</script>

<section class="availability" aria-labelledby="availability-title" aria-busy={loading}>
	<header>
		<div class="heading">
			<h2 id="availability-title">Services · availability</h2>
			<span>who answers the door</span>
		</div>
		<OpButton
			def={probe}
			args={{ target: "all" }}
			{lanes}
			executorLive={probeRunnerLive}
			label="Probe now"
			onfired={() => onrefresh?.()}
		/>
	</header>

	{#if error}
		<div class="source-error" role="status">
			<Icon name="circle-alert" size={16} />
			<span><b>Probe source unreadable.</b> {snapshot ? "Last honest window remains below." : "No honest window is available."}</span>
			<button type="button" onclick={() => onrefresh?.()}>Retry</button>
		</div>
	{/if}

	{#if loading && !snapshot}
		<div class="skeletons" aria-label="Loading service availability">
			{#each Array(5) as _, index (index)}
				<div class="skeleton-row"><i></i><i></i><i></i><i></i></div>
			{/each}
		</div>
	{:else if snapshot?.items.length}
		<div class="rows">
			{#each snapshot.items as item (item.subject)}
				<AvailabilityRow {item} />
			{/each}
		</div>
	{:else if !error}
		<div class="empty">
			<Icon name="circle-help" size={18} />
			<p><b>No watched services have been observed in your scopes.</b> Checks appear after the first scoped <code>service.probe</code> statistic lands.</p>
		</div>
	{/if}

	{#if snapshot}
		<footer>
			<Icon name="receipt-text" size={12} />
			<span>checks run by {snapshot.probe_runner ?? "unknown probe runner"} · {cadence} · {age(snapshot.freshness.observed_at)}</span>
			<a href="/observability?stat=service.probe">Show the math.</a>
		</footer>
	{/if}
</section>

<style>
	.availability {
		background: var(--s1);
		border-radius: var(--r-xs);
		padding: var(--s-3);
		margin-top: var(--s-4);
	}
	header,
	.heading,
	footer,
	.source-error,
	.empty {
		display: flex;
		align-items: center;
	}
	header { justify-content: space-between; gap: var(--s-3); margin-bottom: var(--s-2); }
	.heading { align-items: baseline; gap: var(--s-2); min-width: 0; }
	h2 {
		font: 500 0.6875rem var(--mono);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-3);
		text-wrap: balance;
	}
	.heading span { font-size: 0.75rem; color: var(--text-3); }
	.rows > :global(a:first-child) { border-top: 0; }
	.source-error {
		gap: var(--s-2);
		min-height: 40px;
		padding: var(--s-2);
		background: var(--danger-soft);
		color: var(--danger-text);
		font-size: 0.75rem;
	}
	.source-error b { font-weight: 500; }
	.source-error button {
		margin-inline-start: auto;
		min-height: 32px;
		border: 0;
		border-radius: var(--r-sm);
		padding: 0 var(--s-2);
		background: transparent;
		color: var(--danger-text);
		font-weight: 500;
		cursor: pointer;
	}
	.source-error button:hover { background: var(--danger-soft); }
	.source-error button:focus-visible { outline: 2px solid var(--petal); outline-offset: 2px; }
	.empty { justify-content: center; gap: var(--s-2); min-height: 88px; color: var(--text-3); }
	.empty p { max-width: 60ch; font-size: 0.75rem; }
	.empty b { color: var(--text-2); font-weight: 500; }
	.empty code { font-family: var(--mono); color: var(--text-2); }
	.skeleton-row {
		display: grid;
		grid-template-columns: 160px 88px 96px minmax(120px, 1fr);
		gap: var(--s-3);
		align-items: center;
		min-height: 48px;
		border-top: 1px solid var(--rule);
		padding: var(--s-2);
	}
	.skeleton-row:first-child { border-top: 0; }
	.skeleton-row i {
		display: block;
		height: 8px;
		background: var(--s3);
		border-radius: var(--r-xs);
		animation: breathe 1.2s var(--ease-standard) infinite alternate;
	}
	.skeleton-row i:nth-child(2) { height: 24px; border-radius: var(--r-pill); }
	.skeleton-row i:nth-child(3) { height: 16px; }
	footer {
		gap: var(--s-2);
		border-top: 1px solid var(--rule);
		margin-top: var(--s-2);
		padding-top: var(--s-2);
		font: 400 0.6875rem var(--mono);
		color: var(--text-3);
	}
	footer a {
		display: inline-flex;
		align-items: center;
		min-height: 32px;
		margin: -8px 0 -8px auto;
		color: var(--petal-text);
		font-weight: 500;
		text-decoration: none;
	}
	footer a:hover { text-decoration: underline; text-underline-offset: 2px; }
	footer a:focus-visible { outline: 2px solid var(--petal); outline-offset: 2px; }
	@keyframes breathe { to { opacity: 0.48; } }
	@media (max-width: 640px) {
		.availability { padding: var(--s-2); }
		.heading { display: block; }
		.heading span { display: block; margin-top: 2px; }
		.skeleton-row { grid-template-columns: 1fr 80px; }
		.skeleton-row i:nth-child(3),
		.skeleton-row i:nth-child(4) { display: none; }
		footer { align-items: flex-start; flex-wrap: wrap; }
		footer a { margin-inline-start: 20px; }
	}
	@media (prefers-reduced-motion: reduce) {
		.skeleton-row i { animation: none; }
	}
</style>
