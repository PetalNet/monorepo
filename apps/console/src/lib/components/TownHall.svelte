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
			{#each items as item (item.id)}
				<AttentionCard {item} {lanes} {executorLive} />
			{/each}
		</div>
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
	.sign-sub {
		font:
			400 0.8125rem var(--sign);
		color: var(--text-3);
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
</style>
