<script lang="ts">
	import type { SavedDashboard } from "$lib/data/mock";

	/** Saved dashboards beneath the ask box (foundations §5.5): dashboards are
	 * Library items (kind: artifact). Empty copy from the lore pack. */
	interface Props {
		items: SavedDashboard[];
	}
	let { items }: Props = $props();
</script>

<div class="saved">
	<h3 class="micro">Saved dashboards</h3>
	{#if items.length === 0}
		<p class="empty">No saved dashboards. Ask a question and keep what comes back.</p>
	{:else}
		<div class="saved-row">
			{#each items as d (d.id)}
				<a class="saved-tile" href="/observability?dashboard={d.id}">
					<b>{d.name}</b><span>{d.sub}</span>
				</a>
			{/each}
		</div>
	{/if}
</div>

<style>
	.saved {
		margin-top: var(--s-2);
	}
	.micro {
		margin-bottom: var(--s-2);
	}
	.empty {
		font-size: 0.75rem;
		color: var(--text-3);
	}
	.saved-row {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: var(--s-3);
	}
	.saved-tile {
		background: var(--s1);
		border-radius: var(--r-xs);
		padding: var(--s-2) var(--s-3);
		transition: background var(--t);
		text-decoration: none;
		color: inherit;
	}
	.saved-tile:hover {
		background: var(--s2);
	}
	.saved-tile b {
		font:
			500 0.8125rem var(--sans);
		display: block;
	}
	.saved-tile span {
		font-size: 0.6875rem;
		color: var(--text-3);
		font-family: var(--mono);
	}
	@media (max-width: 640px) {
		.saved-row {
			grid-template-columns: 1fr;
		}
	}
</style>
