<script lang="ts">
	import StatusDot from "./StatusDot.svelte";

	/**
	 * A host as a house in the Neighborhood (foundations §3.7, lore: houses = boxes,
	 * lit windows = active workers). Flavor, not geography. Roof band, lit windows
	 * per active worker, dot-graded health.
	 */
	interface Props {
		host: string;
		workersUp: number;
		/** Total window slots to draw (capacity hint); defaults to max(workersUp, 2). */
		slots?: number;
		tone?: "good" | "warn" | "danger" | "idle";
		dark?: boolean;
	}
	let { host, workersUp, slots, tone = "good", dark = false }: Props = $props();
	const total = $derived(slots ?? Math.max(workersUp, 2));
	const windows = $derived(Array.from({ length: total }, (_, i) => i < workersUp));
</script>

<div class="house" class:dark>
	<div class="roof"></div>
	<div class="body">
		{#each windows as on, i (i)}
			<span class="win" class:on></span>
		{/each}
	</div>
	<div class="name"><StatusDot {tone} size={5} />{host}</div>
</div>

<style>
	.house {
		text-align: center;
	}
	.house.dark {
		opacity: 0.55;
	}
	.roof {
		height: 6px;
		border-radius: 2px 2px 0 0;
		background: var(--jade);
		opacity: 0.55;
	}
	.body {
		background: var(--s2);
		border-radius: 0 0 var(--r-xs) var(--r-xs);
		padding: var(--s-1);
		display: flex;
		gap: 3px;
		justify-content: center;
		min-height: 17px;
	}
	.win {
		width: 7px;
		height: 9px;
		border-radius: 1px;
		background: var(--s3);
	}
	.win.on {
		background: var(--lit);
	}
	.name {
		font:
			400 0.6875rem var(--mono);
		color: var(--text-2);
		margin-top: var(--s-1);
		display: flex;
		align-items: center;
		gap: 3px;
		justify-content: center;
	}
</style>
