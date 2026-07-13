<script lang="ts">
	import { browser } from "$app/environment";
	import { untrack } from "svelte";
	import { dataMode, readRoster } from "$lib/api/client";
	import { registryLiveness } from "$lib/api/derive";
	import type { RosterItem } from "$lib/api/types";
	import AskDock, { type ContextPayload } from "$lib/components/AskDock.svelte";
	import Countdown from "$lib/components/Countdown.svelte";
	import Envelope from "$lib/components/Envelope.svelte";
	import Icon from "$lib/components/Icon.svelte";
	import HouseTile from "$lib/components/HouseTile.svelte";
	import Panel from "$lib/components/Panel.svelte";
	import RailCard from "$lib/components/RailCard.svelte";
	import SavedDashboards from "$lib/components/SavedDashboards.svelte";
	import SurfaceSign, { type Hud } from "$lib/components/SurfaceSign.svelte";
	import TownHall from "$lib/components/TownHall.svelte";
	import { fleet as mockFleet, registry as mockRegistry } from "$lib/data/mock";
	import { clockNow } from "$lib/stores/clock.svelte";

	let { data } = $props();
	const c = $derived(data.cockpit);

	// The ask flow: centered on a fresh cockpit; docks + generates on ask. The
	// initial scene seeds these once (untrack: read without a reactive dep).
	const scene0 = untrack(() => data.scene);
	let asked = $state(scene0 === "asked");
	let progress = $state<string | null>(null);
	let transcript = $state<string | null>(
		scene0 === "asked"
			? "Tuesday was carson-2 retrying the backfill. Panels are up; the prose numbers are live."
			: null,
	);
	let context = $state<ContextPayload | null>(scene0 === "asked" ? { label: "Tuesday · $9.84" } : null);
	let askRef = $state<AskDock | null>(null);
	let railView = $state<"houses" | "residents">("houses");
	let railViewReady = $state(false);
	let residents = $state<RosterItem[]>([]);
	let residentsLoading = $state(false);
	let residentsAttempted = $state(false);
	let residentsError = $state<string | null>(null);
	const railViewKey = $derived(`console:cockpit:rail:${data.me.id}`);

	const now = $derived(clockNow());
	const greeting = (() => {
		const h = new Date().getHours();
		const part = h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
		return `Good ${part}, ${c.greetingName}.`;
	})();
	const dateStr = new Date().toLocaleDateString("en-US", {
		weekday: "short",
		month: "short",
		day: "numeric",
	});

	// needs-you chip: dot graded by the max severity of the set (§2.2); count splits
	// "N new · M held" when items are acked (§4.4).
	const needTone = $derived(
		c.badges["/"] === "p0"
			? "danger"
			: c.badges["/"] === "warn"
				? "warn"
				: c.hud.needsNew + c.hud.needsHeld > 0
					? "info"
					: "idle",
	);
	const hud = $derived<Hud[]>([
		{
			tone: needTone,
			count: c.hud.needsNew,
			label: c.hud.needsHeld > 0 ? `new · ${c.hud.needsHeld} held` : "need you",
		},
		{ tone: "good", count: c.hud.inFlight, label: "in flight" },
		{ tone: "good", count: c.hud.hostsUp, label: `up · ${c.hud.hostsDown} down` },
	]);

	$effect(() => {
		if (!browser || railViewReady) return;
		const saved = localStorage.getItem(railViewKey);
		if (saved === "houses" || saved === "residents") railView = saved;
		railViewReady = true;
	});

	$effect(() => {
		if (!browser || railView !== "residents" || residentsAttempted) return;
		residentsAttempted = true;
		if (dataMode() === "mock") {
			residents = mockFleet.map((row) => ({ ...row, workers_active: row.status === "working" ? 1 : 0 }));
			return;
		}
		residentsLoading = true;
		void readRoster()
			.then((result) => (residents = result.items))
			.catch((error: unknown) => {
				residentsError = error instanceof Error ? error.message : "Roster read failed";
			})
			.finally(() => (residentsLoading = false));
	});

	function selectRailView(next: "houses" | "residents") {
		railView = next;
		if (browser) localStorage.setItem(railViewKey, next);
	}

	function railTone(host: string) {
		const reg = mockRegistry.find((r) => r.host === host);
		if (!reg) return "idle" as const;
		const live = registryLiveness(reg, now);
		return live === "alive" ? ("good" as const) : live === "suspect" ? ("warn" as const) : ("danger" as const);
	}

	async function onAsk(_q: string) {
		asked = true;
		context = null;
		transcript = null;
		// Staged honest progress (foundations §5.1): compiling -> querying -> laying out.
		const stages = ["Compiling the question.", "Querying the lake.", "Laying out the panels."];
		for (const s of stages) {
			progress = s;
			// Sequential by design: the stages must render one after another.
			// eslint-disable-next-line no-await-in-loop
			await new Promise((r) => setTimeout(r, 420));
		}
		progress = null;
		transcript = "Here is what I found. Every number is live; the prose stats drill.";
	}

	function askAbout(label: string) {
		context = { label };
		asked = true;
		queueMicrotask(() => askRef?.focus());
	}

	// Right-click-ask, the universal primitive (§4.3, /task/700): capture the
	// clicked element's context and inject it into the chat. Delegated over the
	// cockpit so any element (a card, a house, a saved tile) is interrogable,
	// not just generated panels. Selected text yields the native menu.
	function askAboutClick(e: MouseEvent) {
		if (window.getSelection()?.toString()) return;
		const el = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-ask]");
		if (!el) return;
		e.preventDefault();
		askAbout(el.dataset.ask || el.textContent?.trim().slice(0, 60) || "this");
	}

	function onKey(e: KeyboardEvent) {
		const el = e.target as HTMLElement | null;
		const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
		if (e.key === "/" && !typing) {
			e.preventDefault();
			askRef?.focus();
		} else if (e.key === "Escape") {
			context = null;
		}
	}
</script>

<svelte:window onkeydown={onKey} />

{#if asked}
	<!-- Asked: the bar docks, Janet composes the window (foundations §5.1). -->
	<SurfaceSign title="Fleet cost, this week" date="generated · 4 panels · 1 refused" />
	<div class="dash">
		<Panel title="Total spend" sub="Mon to now, all agents" span={4}
			prov={{ source: "stats.query", rows: "7 rows", freshness: "2s ago" }}
			onaskabout={() => askAbout("Total spend · $41.20")}>
			<div class="stat-big">$41.20<small>this week</small></div>
			<div class="delta-up">+18% vs last week</div>
		</Panel>
		<Panel title="Daily spend by agent" sub="Tuesday carries the spike" span={8}
			prov={{ source: "stats.query", rows: "42 rows", freshness: "2s ago" }}
			onaskabout={() => askAbout("Daily spend by agent")}>
			<svg class="chart" viewBox="0 0 560 96" preserveAspectRatio="none" role="img"
				aria-label="Daily spend line chart, Tuesday peak">
				<line x1="0" y1="88" x2="560" y2="88" stroke="var(--rule-strong)" stroke-width="1" />
				<line x1="0" y1="48" x2="560" y2="48" stroke="var(--rule)" stroke-width="1" />
				<line x1="0" y1="8" x2="560" y2="8" stroke="var(--rule)" stroke-width="1" />
				<polyline fill="none" stroke="var(--petal)" stroke-width="2" stroke-linejoin="round"
					points="10,70 100,62 190,14 280,55 370,60 460,52 550,58" />
				<circle cx="190" cy="14" r="3.5" fill="var(--petal)" />
			</svg>
		</Panel>
		<Panel title="Why Tuesday" span={7}
			prov={{ source: "5 bound stats", rows: null, freshness: "all live" }}
			onaskabout={() => askAbout("Why Tuesday")}>
			<p class="prose">
				Tuesday's spike is <span class="istat">$9.84</span>, of which
				<span class="istat">$7.10</span> came from <span class="istat">carson-2</span> retrying the
				library backfill <span class="istat">31 times</span> after a schema change. The retries
				stopped once the migration landed at <span class="istat">16:40</span>.
			</p>
		</Panel>
		<Panel title="Top spenders" span={5}
			prov={{ source: "stats.query", rows: "3 of 9 rows", freshness: "2s ago" }}
			onaskabout={() => askAbout("Top spenders")}>
			<table class="mini-table">
				<thead>
					<tr><th>agent</th><th>spend</th><th>share</th></tr>
				</thead>
				<tbody>
					<tr><td>carson-2</td><td>$14.02</td><td>34%</td></tr>
					<tr><td>janet</td><td>$9.77</td><td>24%</td></tr>
					<tr><td>point-fable</td><td>$8.91</td><td>22%</td></tr>
				</tbody>
			</table>
		</Panel>
		<div class="refused">
			<div class="ref-head">Can't answer: cost per commit</div>
			<p>Commits are not joined to token spend yet. No chart, no guess.</p>
			<span class="alt">Try: spend per closed task</span>
		</div>
	</div>

	<AskDock bind:this={askRef} mode="docked" {context} {progress} {transcript}
		assistantDown={!data.connected} onask={onAsk} onclearcontext={() => (context = null)} />
{:else}
	<!-- All clear: a pinned home around the ask (foundations §5.5). -->
	<SurfaceSign hero title={greeting} verdict={c.verdict} stateFact={c.stateFact} date={dateStr}
		{hud} />

	<AskDock bind:this={askRef} mode="centered" {context} assistantDown={!data.connected}
		onask={onAsk} onclearcontext={() => (context = null)} />

	{#if !c.connected}
		<!-- Live, not connected: honest placeholder, never fabricated fixtures (veto #20). -->
		<div class="unverified">
			<Icon name="circle-help" size={20} />
			<p>Can't verify the neighborhood. No live read or last-known snapshot is available.</p>
			<span>Ask Janet anything — every surface is still live.</span>
		</div>
	{:else}
		<div class="home-grid" oncontextmenu={askAboutClick} role="presentation">
			<div class="home-main">
				<div data-ask="Town Hall, the attention board">
					<TownHall items={c.attention} lanes={data.me.lanes} />
				</div>
				<div class="phone-hide"><SavedDashboards items={c.saved} lanes={data.me.lanes} userId={data.me.id} /></div>
			</div>
			<aside class="rail phone-hide">
				<RailCard heading="The neighborhood">
					<div class="rail-tools">
						<div class="rail-meta">{c.railHosts.filter((h) => !h.dark).length} houses · {c.hud.inFlight} workers up</div>
						<div class="rail-flip" aria-label="Neighborhood view">
							<button class:selected={railView === "houses"} aria-pressed={railView === "houses"} onclick={() => selectRailView("houses")}>Houses</button>
							<button class:selected={railView === "residents"} aria-pressed={railView === "residents"} onclick={() => selectRailView("residents")}>Residents</button>
						</div>
					</div>
					{#key railView}<div class="rail-view" aria-live="polite">
						{#if railView === "houses"}
							<div class="house-row">
								{#each c.railHosts as h (h.host)}
									<div data-ask="host {h.host}">
										<HouseTile host={h.host} workersUp={h.workersUp} tone={railTone(h.host)} dark={h.dark} />
									</div>
								{/each}
							</div>
						{:else if residentsLoading}
							<div class="resident-skeleton" aria-label="Loading residents"><span></span><span></span><span></span></div>
						{:else if residentsError}
							<p class="rail-empty danger">Residents unavailable. {residentsError}</p>
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
	.rail-empty.danger { color: var(--danger-text); background: var(--danger-soft); border-radius: var(--r-xs); }
	.resident-skeleton { display: grid; gap: var(--s-1); }
	.resident-skeleton span { display: block; height: 32px; border-radius: var(--r-xs); background: var(--s2); animation: resident-pulse 1.2s ease-in-out infinite alternate; }
	@keyframes rail-crossfade { from { opacity: 0.55; } to { opacity: 1; } }
	@keyframes resident-pulse { to { background: var(--s3); } }
	/* generated dashboard */
	.dash {
		display: grid;
		grid-template-columns: repeat(12, 1fr);
		gap: var(--s-3);
		margin-top: var(--s-3);
		padding-bottom: 112px;
	}
	.stat-big {
		font:
			500 1.75rem var(--mono);
		font-feature-settings: "tnum" 1;
	}
	.stat-big small {
		font:
			400 0.75rem var(--sans);
		color: var(--text-3);
		margin-inline-start: var(--s-1);
	}
	.delta-up {
		color: var(--good-text);
		font:
			500 0.75rem var(--mono);
	}
	.prose {
		font-size: 0.8125rem;
		color: var(--text-2);
		line-height: 1.65;
	}
	.prose :global(.istat) {
		font-family: var(--mono);
		font-size: 0.78125rem;
		color: var(--text);
		background: var(--jade-soft);
		border-bottom: 1px solid var(--jade);
		border-radius: var(--r-xs);
		padding: 0 var(--s-1);
	}
	.mini-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.75rem;
	}
	.mini-table th {
		text-align: start;
		font:
			500 0.6875rem var(--mono);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-3);
		padding: var(--s-1) var(--s-2) var(--s-1) 0;
		border-bottom: 1px solid var(--rule-strong);
	}
	.mini-table td {
		padding: var(--s-1) var(--s-2) var(--s-1) 0;
		border-bottom: 1px solid var(--rule);
		font-family: var(--mono);
		font-feature-settings: "tnum" 1;
		color: var(--text-2);
	}
	.chart {
		width: 100%;
		height: 96px;
		display: block;
	}
	.refused {
		grid-column: span 12;
		display: flex;
		flex-direction: column;
		gap: var(--s-1);
		align-items: flex-start;
		background: var(--s1);
		border-radius: var(--r-md);
		padding: var(--s-3);
	}
	.ref-head {
		font:
			500 0.8125rem var(--sans);
		color: var(--warn-text);
	}
	.refused p {
		font-size: 0.75rem;
		color: var(--text-3);
	}
	.alt {
		display: inline-flex;
		background: var(--s2);
		border-radius: var(--r-pill);
		padding: var(--s-1) var(--s-2);
		font-size: 0.6875rem;
		color: var(--text-2);
	}
	@media (max-width: 1023px) {
		.home-grid {
			grid-template-columns: 1fr;
		}
		.dash :global(.panel) {
			grid-column: span 12 !important;
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
		.rail-view, .resident-skeleton span { animation: none; }
	}
</style>
