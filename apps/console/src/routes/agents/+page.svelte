<script lang="ts">
	import type { RosterItem } from "$lib/api/types";
	import FleetStrip from "$lib/components/FleetStrip.svelte";
	import Icon from "$lib/components/Icon.svelte";
	import RosterRow from "$lib/components/RosterRow.svelte";
	import SurfaceSign from "$lib/components/SurfaceSign.svelte";
	import { deriveRoster } from "$lib/data/agents";
	import { clockNow } from "$lib/stores/clock.svelte";

	let { data } = $props();
	const a = $derived(data.agents);
	// Live clock: countdowns tick and gone-quiet crosses its window without a refresh.
	const now = $derived(clockNow());
	const roster = $derived(deriveRoster(a.roster, now));

	let filter = $state("");
	function match(rows: RosterItem[]): RosterItem[] {
		const q = filter.trim().toLowerCase();
		return q ? rows.filter((r) => r.handle.toLowerCase().includes(q)) : rows;
	}
	const lanes = $derived([
		{ key: "Needs you", rows: match(roster.lanes.needs) },
		{ key: "Working", rows: match(roster.lanes.working) },
		{ key: "Idle", rows: match(roster.lanes.idle) },
	]);
</script>

<div class="util">
	<SurfaceSign title="Agents" />
	<label class="filter">
		<Icon name="users-round" size={14} />
		<input bind:value={filter} placeholder="Filter residents" aria-label="Filter residents" />
	</label>
</div>

{#if !a.connected}
	<div class="unverified">
		<Icon name="circle-help" size={20} />
		<p>Can't verify the roster yet. The /roster read lands with the backend's 2nd pass.</p>
		<span>Ask Janet anything — every surface is still live.</span>
	</div>
{:else}
	<div class="strip-wrap">
		<FleetStrip summary={a.summary} health={roster.health} />
	</div>

	<div class="roster">
		{#each lanes as lane (lane.key)}
			{#if lane.rows.length > 0}
				<div class="lane-head">
					<span class="micro">{lane.key}</span>
					<span class="count">{lane.rows.length}</span>
				</div>
				{#each lane.rows as row (row.handle)}
					<RosterRow {row} lanes={data.me.lanes} {now} />
				{/each}
			{/if}
		{/each}
	</div>
{/if}

<style>
	.util {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--s-3);
		flex-wrap: wrap;
	}
	.filter {
		display: inline-flex;
		align-items: center;
		gap: var(--s-2);
		background: var(--s2);
		border-radius: var(--r-sm);
		padding: 0 var(--s-3);
		height: 32px;
		width: 240px;
		max-width: 100%;
	}
	.filter :global(svg) {
		color: var(--text-3);
		flex: none;
	}
	.filter input {
		flex: 1;
		border: 0;
		background: transparent;
		color: var(--text);
		font:
			400 0.8125rem var(--sans);
		min-width: 0;
	}
	.filter input:focus {
		outline: none;
	}
	.strip-wrap {
		margin-top: var(--s-3);
	}
	.roster {
		margin-top: var(--s-4);
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.lane-head {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		height: 24px;
		margin-top: var(--s-3);
	}
	.lane-head:first-child {
		margin-top: 0;
	}
	.count {
		font:
			500 0.6875rem var(--mono);
		font-feature-settings: "tnum" 1;
		color: var(--text-3);
	}
	.unverified {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--s-2);
		text-align: center;
		padding: var(--s-6) var(--s-4);
		color: var(--text-3);
	}
	.unverified :global(svg) {
		color: var(--warn-dot);
	}
	.unverified p {
		font-size: 0.875rem;
		color: var(--text-2);
		max-width: 46ch;
	}
</style>
