<script lang="ts">
	import type { PageProps } from "./$types";
	import { browser } from "$app/env";
	import { connectBus } from "$lib/rpc/browser";
	import CockpitSkeleton from "$lib/components/CockpitSkeleton.svelte";
	import Countdown from "$lib/components/Countdown.svelte";
	import Envelope from "$lib/components/Envelope.svelte";
	import Icon from "$lib/components/Icon.svelte";
	import HouseTile from "$lib/components/HouseTile.svelte";
	import RailCard from "$lib/components/RailCard.svelte";
	import SavedDashboards from "$lib/components/SavedDashboards.svelte";
	import SurfaceSign, { type Hud } from "$lib/components/SurfaceSign.svelte";
	import TownHall from "$lib/components/TownHall.svelte";
	import { newestCrack } from "$lib/data/cockpit";
	import { clockNow } from "$lib/stores/clock.svelte";
	import { getCockpit } from "./cockpit.remote";
	import type { CockpitRemoteResult } from "./cockpit.remote";

	let { data }: PageProps = $props();
	const cockpitQuery = getCockpit();
	const cockpitCacheKey = $derived(`console:cockpit:snapshot:${data.me.id}`);
	let cachedRemote = $state<CockpitRemoteResult | null>(null);
	let cacheLoaded = $state(false);
	const remote = $derived.by(() => {
		const current = cockpitQuery.current;
		if (!current) return cachedRemote;
		if (!cachedRemote || current.staleSources.length === 0) return current;
		return {
			...current,
			cockpit: {
				...cachedRemote.cockpit,
				greetingName: current.cockpit.greetingName,
				connected: current.cockpit.connected,
				verdict: current.cockpit.verdict,
				stateFact: current.cockpit.stateFact,
			},
		};
	});
	const c = $derived(remote?.cockpit ?? null);
	const staleSources = $derived(remote?.staleSources ?? []);
	const usingCached = $derived(!cockpitQuery.current && cachedRemote !== null);
	const leadCrack = $derived(c ? newestCrack(c.attention) : null);
	const crackLead = $derived(leadCrack?.fix_ops?.[0]);

	let railView = $state<"houses" | "residents">("houses");
	let railViewReady = $state(false);
	const railViewKey = $derived(`console:cockpit:rail:${data.me.id}`);
	const residents = $derived(c?.residents ?? []);

	const now = $derived(clockNow());
	const greeting = $derived.by(() => {
		const h = new Date().getHours();
		const part = h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
		return `Good ${part}, ${c?.greetingName ?? data.me.display_name ?? data.me.id}.`;
	});
	const dateStr = new Date().toLocaleDateString("en-US", {
		weekday: "short",
		month: "short",
		day: "numeric",
	});

	// needs-you chip: dot graded by the max severity of the set (§2.2); count splits
	// "N new · M held" when items are acked (§4.4).
	const needTone = $derived(
		c?.badges["/"] === "p0"
			? "danger"
			: c?.badges["/"] === "warn"
				? "warn"
				: (c?.hud.needsNew ?? 0) + (c?.hud.needsHeld ?? 0) > 0
					? "info"
					: "idle",
	);
	const hud = $derived<Hud[]>(
		c
			? [
					{
						tone: needTone,
						count: c.hud.needsNew,
						label: c.hud.needsHeld > 0 ? `new · ${String(c.hud.needsHeld)} held` : "need you",
					},
					{ tone: "good", count: c.hud.inFlight, label: "in flight" },
					{ tone: "good", count: c.hud.hostsUp, label: `up · ${String(c.hud.hostsDown)} down` },
				]
			: [],
	);

	$effect(() => {
		if (!browser) return;
		if (!cacheLoaded) {
			cacheLoaded = true;
			try {
				const raw = localStorage.getItem(cockpitCacheKey);
				cachedRemote = raw ? (JSON.parse(raw) as CockpitRemoteResult) : null;
			} catch {
				cachedRemote = null;
			}
		}
		const current = cockpitQuery.current;
		if (current?.isMock === false)
			try {
				localStorage.setItem(cockpitCacheKey, JSON.stringify(current));
			} catch {
				// A denied/full cache must never take down the live cockpit.
			}
	});

	$effect(() => {
		if (!browser || railViewReady) return;
		const saved = localStorage.getItem(railViewKey);
		if (saved === "houses" || saved === "residents") railView = saved;
		railViewReady = true;
	});

	$effect(() => {
		if (!browser || cockpitQuery.current?.isMock !== false) return;
		let queued: ReturnType<typeof setTimeout> | null = null;
		const disconnect = connectBus(
			() => [{ sub_id: "console-cockpit-attention", pattern: "attention.**" }],
			(frame) => {
				if (frame["kind"] !== "event") return;
				if (queued) clearTimeout(queued);
				queued = setTimeout(() => {
					queued = null;
					void cockpitQuery.refresh();
				}, 250);
			},
		);
		return () => {
			if (queued) clearTimeout(queued);
			disconnect();
		};
	});

	function selectRailView(next: "houses" | "residents") {
		railView = next;
		if (browser) localStorage.setItem(railViewKey, next);
	}

	function railTone(host: { tone?: "good" | "warn" | "danger" | "idle"; dark: boolean }) {
		return host.tone ?? (host.dark ? "danger" : "good");
	}

</script>

	{#if !c}
		<SurfaceSign hero title={greeting} date={dateStr} />
		{#if cockpitQuery.error}
			<div class="unverified" role="status">
				<Icon name="circle-help" size={20} />
				<p>Can't read the cockpit. Retrying will preserve the last known layout.</p>
				<button type="button" onclick={() => cockpitQuery.refresh()}>Retry</button>
			</div>
		{:else}
			<CockpitSkeleton />
		{/if}
	{:else}
		<!-- A pinned home around the ask (foundations §5.5). -->
		<SurfaceSign hero title={greeting} verdict={c.verdict} stateFact={c.stateFact}
			crackMeta={c.crackMeta} {crackLead} lanes={data.me.lanes} date={dateStr} {hud} />

		{#if remote?.isMock}
			<div class="fixture-chip" role="status">Fixture data · mock mode</div>
		{/if}

		{#if cockpitQuery.error || staleSources.length > 0 || usingCached}
			<div class="source-warning" role="status">
				<Icon name="circle-help" size={16} />
				<span>{cockpitQuery.error || usingCached ? "Live refresh pending; showing the last known cockpit." : `Waiting for ${staleSources.join(", ")}. Available evidence remains in place.`}</span>
				<button type="button" onclick={() => cockpitQuery.refresh()}>Retry</button>
			</div>
		{/if}

		{#if !c.connected}
		<!-- Live, not connected: honest placeholder, never fabricated fixtures (veto #20). -->
		<div class="unverified">
			<Icon name="circle-help" size={20} />
			<p>Can't verify the neighborhood. No live read or last-known snapshot is available.</p>
			<span>Ask Janet anything — every surface is still live.</span>
		</div>
		{:else}
		<div class="home-grid" role="presentation">
			<div class="home-main">
				<div id="attention" data-ask="Town Hall, the attention board">
					<TownHall items={c.attention} lanes={data.me.lanes} />
				</div>
				<div class="phone-hide"><SavedDashboards items={c.saved} lanes={data.me.lanes} userId={data.me.id} /></div>
			</div>
			<aside class="rail phone-hide">
				<RailCard heading="The neighborhood">
					<div class="rail-tools">
						<div class="rail-meta">{c.railHosts.filter((h) => !h.dark).length} houses · {c.hud.inFlight} workers up</div>
						<div class="rail-flip" aria-label="Neighborhood view">
							<button class:selected={railView === "houses"} aria-pressed={railView === "houses"} onclick={() => { selectRailView("houses"); }}>Houses</button>
							<button class:selected={railView === "residents"} aria-pressed={railView === "residents"} onclick={() => { selectRailView("residents"); }}>Residents</button>
						</div>
					</div>
					{#key railView}<div class="rail-view" aria-live="polite">
						{#if railView === "houses"}
							<div class="house-row">
								{#each c.railHosts as h (h.host)}
									<div data-ask="host {h.host}">
										<HouseTile host={h.host} workersUp={h.workersUp} tone={railTone(h)} dark={h.dark} />
									</div>
								{/each}
							</div>
						{:else if residents.length === 0}
							<p class="rail-empty">No residents yet. The neighborhood is waiting.</p>
						{:else}
							<div class="resident-list">
								{#each residents as resident (resident.handle)}
									<div class="resident-row" data-ask="resident {resident.handle}">
										<span class:working={resident.status === "working"} class="resident-dot" aria-hidden="true"></span>
										<div><b>{resident.handle}</b><span>{resident.current_tool ?? resident.status ?? "idle"}</span></div>
										{#if resident.lease_expires_at}<code><Countdown expiresAt={resident.lease_expires_at} {now} /></code>{/if}
									</div>
								{/each}
							</div>
						{/if}
					</div>{/key}
				</RailCard>
				<RailCard heading="Mail on the wire">
					{#each c.comms as ev, i (ev.id)}
						<Envelope event={ev} rate={i === 1 ? 12 : null} {now} />
					{/each}
				</RailCard>
			</aside>
		</div>
		{/if}
	{/if}

<style>
	.home-grid {
		display: grid;
		grid-template-columns: 1fr 344px;
		gap: var(--s-3);
		margin-top: var(--s-4);
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
	.unverified span {
		font-size: 0.75rem;
	}
	.source-warning {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		margin-top: var(--s-3);
		padding: var(--s-2) var(--s-3);
		border-radius: var(--r-sm);
		background: var(--warn-soft);
		color: var(--warn-text);
		font-size: 0.75rem;
	}
	.source-warning :global(svg) { flex: none; color: var(--warn-dot); }
	.source-warning button {
		margin-inline-start: auto;
		min-height: 32px;
		border: 0;
		border-radius: var(--r-sm);
		padding: 0 var(--s-2);
		background: var(--s2);
		color: var(--text);
		font: 500 0.75rem var(--sans);
		cursor: pointer;
	}
	.fixture-chip {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
		margin-top: var(--s-2);
		border: 1px solid var(--warn-dot);
		border-radius: var(--r-pill);
		padding: 0 var(--s-2);
		background: var(--warn-soft);
		color: var(--warn-text);
		font: 500 0.6875rem var(--mono);
	}
	.home-main {
		display: flex;
		flex-direction: column;
		gap: var(--s-3);
		min-width: 0;
	}
	.rail {
		display: flex;
		flex-direction: column;
		gap: var(--s-3);
	}
	.rail-meta {
		font:
			400 0.6875rem var(--mono);
		color: var(--text-3);
	}
	.rail-tools {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--s-2);
		margin-bottom: var(--s-2);
	}
	.rail-flip {
		display: inline-flex;
		background: var(--s2);
		border-radius: var(--r-pill);
		padding: 2px;
	}
	.rail-flip button {
		min-height: 32px;
		border: 0;
		border-radius: var(--r-pill);
		padding: 0 var(--s-2);
		background: transparent;
		color: var(--text-3);
		font: 500 0.6875rem var(--sans);
		cursor: pointer;
		transition: background var(--dur-fast) var(--ease-standard), color var(--dur-fast) var(--ease-standard);
	}
	.rail-flip button:hover { background: var(--s3); }
	.rail-flip button.selected { background: var(--petal-soft); color: var(--petal-text); }
	.rail-flip button:focus-visible { outline: 2px solid var(--petal); outline-offset: 2px; }
	.rail-view { animation: rail-crossfade var(--dur-fast) var(--ease-standard); }
	.house-row {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: var(--s-2);
	}
	.resident-list { display: flex; flex-direction: column; }
	.resident-row {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		min-height: 32px;
		padding: 0 var(--s-1);
		border-top: 1px solid var(--rule);
	}
	.resident-row:first-child { border-top: 0; }
	.resident-row > div { display: flex; min-width: 0; align-items: baseline; gap: var(--s-2); }
	.resident-row b { font: 500 0.75rem var(--sans); }
	.resident-row span, .resident-row code { font: 400 0.6875rem var(--mono); color: var(--text-3); }
	.resident-row code { margin-inline-start: auto; }
	.resident-dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--text-3); }
	.resident-dot.working { background: var(--good-dot); }
	.rail-empty { padding: var(--s-3) var(--s-2); font-size: 0.75rem; color: var(--text-3); }
	@keyframes rail-crossfade { from { opacity: 0.55; } to { opacity: 1; } }
	@media (max-width: 1023px) {
		.home-grid {
			grid-template-columns: 1fr;
		}
	}
	/* Phone lens (<768, foundations §2.1): attention list + chat dock only. The
	 * fleet rail, mail, and saved dashboards are one ask away, not on the phone. */
	@media (max-width: 767px) {
		.phone-hide {
			display: none;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.rail-view { animation: none; }
	}
</style>
