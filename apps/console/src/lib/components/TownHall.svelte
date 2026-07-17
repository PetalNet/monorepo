<script lang="ts">
	import type { AttentionItem } from "$lib/api/types";
	import AttentionCard from "./AttentionCard.svelte";
	import Icon from "./Icon.svelte";

	/**
	 * The cockpit attention board (foundations §4.4). Signs as Town Hall, plain
	 * subtitle "Needs you". Severity-first order, incidents collapsed upstream.
	 * Empty (green) = "All caught up." — but only honestly, the hero fine line
	 * carries the positive-evidence check.
	 */
	interface Props {
		items: AttentionItem[];
		lanes: string[];
		executorLive?: Record<string, boolean>;
	}
	let { items, lanes, executorLive = {} }: Props = $props();

	const VISIBLE = 7;
	let expanded = $state(false);
	const shown = $derived(expanded ? items : items.slice(0, VISIBLE));
	const overflow = $derived(Math.max(0, items.length - VISIBLE));
</script>

<section class="town">
	<div class="pin-head">
		<h3 class="micro">Needs you</h3>
		<span class="sign-sub">Town Hall</span>
	</div>
	{#if items.length === 0}
		<div class="town-empty"><Icon name="circle-check" size={14} /> All caught up.</div>
	{:else}
		<div class="stack">
			{#each shown as item (item.id)}
				<AttentionCard {item} {lanes} {executorLive} />
			{/each}
		</div>
		{#if overflow > 0}
			<button class="more-row" onclick={() => (expanded = !expanded)}>
				{expanded ? "Show less" : `${String(overflow)} more`}
			</button>
		{/if}
	{/if}
</section>

<style>
	.town {
		background: var(--s1);
		border-radius: var(--r-xs);
		padding: var(--s-3);
	}
	.pin-head {
		display: flex;
		align-items: baseline;
		gap: var(--s-2);
		margin-bottom: var(--s-2);
	}
	/* Signage secondary in sans, not serif: the one serif (sign-face) moment per
	 * screen is the greeting row (foundations §7). */
	.sign-sub {
		font:
			400 0.8125rem var(--sans);
		color: var(--text-3);
		font-style: italic;
	}
	.town-empty {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		color: var(--text-3);
		font-size: 0.8125rem;
		padding: var(--s-3) 0;
		justify-content: center;
	}
	.town-empty :global(svg) {
		color: var(--good-dot);
	}
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--s-2);
	}
	.more-row {
		width: 100%;
		margin-top: var(--s-2);
		padding: var(--s-2);
		background: transparent;
		border: 0;
		border-top: 1px solid var(--rule);
		color: var(--text-3);
		font:
			500 0.75rem var(--mono);
		cursor: pointer;
		border-radius: var(--r-xs);
		transition: background var(--t);
	}
	.more-row:hover {
		background: var(--s2);
	}
</style>
