<script lang="ts">
	import { page } from "$app/state";
	import { onMount } from "svelte";
	import { connectBus } from "$lib/rpc/browser";
	import AvailabilityPanel from "$lib/components/AvailabilityPanel.svelte";
	import HostCard from "$lib/components/HostCard.svelte";
	import HudChip from "$lib/components/HudChip.svelte";
	import Icon from "$lib/components/Icon.svelte";
	import SurfaceSign from "$lib/components/SurfaceSign.svelte";
	import { getAvailability } from "./availability.remote";

	let { data } = $props();
	const h = $derived(data.hosts);
	// The cockpit crack card links /hosts?host=<h>; highlight that house (§3.7).
	const focusHost = $derived(page.url.searchParams.get("host"));
	const availabilityQuery = getAvailability();

	let filter = $state("");
	const shown = $derived(
		filter.trim()
			? h.hosts.filter((x) => x.host.toLowerCase().includes(filter.trim().toLowerCase()))
			: h.hosts,
	);
	const allQuiet = $derived(h.connected && h.hosts.length > 0 && h.hosts.every((x) => x.quiet));

	onMount(() => {
		if (data.isMock) return;
		let queued: ReturnType<typeof setTimeout> | null = null;
		const refreshSoon = () => {
			if (queued) return;
			queued = setTimeout(() => {
				queued = null;
				void availabilityQuery.refresh();
			}, 250);
		};
		const disconnect = connectBus(
			() => [{ sub_id: "console-hosts-availability", pattern: "service.*" }],
			(frame) => {
				if (frame["kind"] === "event" || frame["kind"] === "gap" || frame["kind"] === "resync_required")
					refreshSoon();
			},
		);
		return () => {
			if (queued) clearTimeout(queued);
			disconnect();
		};
	});
</script>

<div class="util">
	<SurfaceSign
		title="Hosts"
		verdict={h.connected ? (allQuiet ? "fine" : "needs_you") : "cant_verify"}
		stateFact={allQuiet ? "Every house is quiet. Everything is fine." : null}
	/>
	<label class="filter">
		<Icon name="server" size={14} />
		<input bind:value={filter} placeholder="Filter houses" aria-label="Filter houses" />
	</label>
</div>

{#if !h.connected}
	<div class="unverified">
		<Icon name="circle-help" size={20} />
		<p>Can't verify the neighborhood. No host read or last-known snapshot is available.</p>
	</div>
{:else}
	<div class="hud">
		<HudChip tone="good" count={h.hud.housesUp} label="houses up" />
		<HudChip tone="good" count={h.hud.residents} label="residents" />
		<HudChip tone="idle" count={h.hud.containers ?? "—"} label="containers" />
	</div>
	{#if Object.values(data.sources).some((source) => source !== "live")}
		<p class="source-note" role="status">
			<Icon name="radio-tower" size={14} />
			{Object.entries(data.sources).filter(([, state]) => state !== "live").map(([source, state]) => `${source} ${state}`).join(" · ")}
		</p>
	{/if}

	<div class="grid">
		{#each shown as host (host.host)}
			<HostCard {host} highlighted={host.host === focusHost} />
		{/each}
	</div>
{/if}

<AvailabilityPanel
	snapshot={availabilityQuery.current?.snapshot}
	loading={availabilityQuery.loading}
	error={availabilityQuery.error}
	lanes={data.me.lanes}
	probeRunnerLive={availabilityQuery.current?.probe_runner_live ?? false}
	onrefresh={() => void availabilityQuery.refresh()}
/>

{#if h.connected}
	<p class="note">
		The grid is a renderer. The substrate already carries what a spatial neighborhood view needs —
		hosts, residents, containers — so it layers on later with no re-wiring.
	</p>
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
	.filter:focus-within {
		box-shadow: 0 0 0 2px var(--petal);
	}
	.hud {
		display: flex;
		gap: var(--s-2);
		margin-top: var(--s-3);
		flex-wrap: wrap;
	}
	.source-note {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		margin-top: var(--s-3);
		color: var(--warn-text);
		font: 500 0.75rem var(--mono);
	}
	.grid {
		margin-top: var(--s-4);
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(216px, 1fr));
		gap: var(--s-3);
	}
	.note {
		margin-top: var(--s-4);
		font-size: 0.75rem;
		color: var(--text-3);
		max-width: 70ch;
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
	@media (max-width: 767px) {
		.filter { width: 100%; }
		.grid {
			display: flex;
			flex-direction: column;
			gap: 1px;
			margin-top: var(--s-3);
		}
		.note { display: none; }
	}
</style>
