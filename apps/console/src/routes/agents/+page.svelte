<script lang="ts">
	import type { HeartbeatItem, RosterItem } from "$lib/api/types";
	import FleetStrip from "$lib/components/FleetStrip.svelte";
	import Icon from "$lib/components/Icon.svelte";
	import RosterRow from "$lib/components/RosterRow.svelte";
	import SurfaceSign from "$lib/components/SurfaceSign.svelte";
	import StatusPill from "$lib/components/StatusPill.svelte";
	import { deriveRoster } from "$lib/data/agents";
	import { clockNow } from "$lib/stores/clock.svelte";

	let { data } = $props();
	const a = $derived(data.agents);
	// Live clock: countdowns tick and gone-quiet crosses its window without a refresh.
	const now = $derived(clockNow());
	const roster = $derived(deriveRoster(a.roster, now));

	let filter = $state("");
	let view = $state<"residents" | "architects">("residents");
	function match(rows: RosterItem[]): RosterItem[] {
		const q = filter.trim().toLowerCase();
		return q ? rows.filter((r) => r.handle.toLowerCase().includes(q)) : rows;
	}
	const lanes = $derived([
		{ key: "Needs you", rows: match(roster.lanes.needs) },
		{ key: "Working", rows: match(roster.lanes.working) },
		{ key: "Idle", rows: match(roster.lanes.idle) },
	]);
	const architects = $derived.by(() => {
		const byHost = new Map<string, { host: string; heartbeat: HeartbeatItem; residents: string[] }>();
		const rank: Record<HeartbeatItem["state"], number> = {
			crashed: 5,
			stopped: 4,
			rate_limited: 3,
			waiting: 2,
			starting: 1,
			running: 0,
		};
		for (const heartbeat of data.architects) {
			const current = byHost.get(heartbeat.host);
			if (!current) {
				byHost.set(heartbeat.host, {
					host: heartbeat.host,
					heartbeat,
					residents: heartbeat.handle ? [heartbeat.handle] : [],
				});
				continue;
			}
			if (heartbeat.handle && !current.residents.includes(heartbeat.handle)) current.residents.push(heartbeat.handle);
			if (rank[heartbeat.state] > rank[current.heartbeat.state]) current.heartbeat = heartbeat;
		}
		const q = filter.trim().toLowerCase();
		return [...byHost.values()]
			.filter(
				(architect) =>
					!q ||
					architect.host.toLowerCase().includes(q) ||
					architect.residents.some((resident) => resident.toLowerCase().includes(q)),
			)
			.toSorted((left, right) => left.host.localeCompare(right.host));
	});
	function stateTone(state: HeartbeatItem["state"]): "good" | "warn" | "danger" | "idle" {
		if (state === "crashed" || state === "stopped") return "danger";
		if (state === "rate_limited" || state === "waiting") return "warn";
		return state === "running" ? "good" : "idle";
	}
	function age(epoch: number): string {
		if (epoch === 0) return "never";
		const seconds = Math.max(0, Math.floor(now / 1_000 - epoch));
		return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
	}
	function managerStale(heartbeat: HeartbeatItem): boolean {
		return now - Date.parse(heartbeat.observed_at) > 90_000;
	}
	function flipKey(event: KeyboardEvent) {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		event.preventDefault();
		view = view === "residents" ? "architects" : "residents";
		(event.currentTarget as HTMLElement).parentElement?.querySelector<HTMLElement>(`[data-view="${view}"]`)?.focus();
	}
</script>

<div class="util">
	<SurfaceSign title="Agents" />
	<div class="flip" role="tablist" aria-label="Agent view">
		<button data-view="residents" role="tab" aria-selected={view === "residents"} aria-controls="residents-panel" tabindex={view === "residents" ? 0 : -1} class:on={view === "residents"} onkeydown={flipKey} onclick={() => (view = "residents")}>Residents</button>
		<button data-view="architects" role="tab" aria-selected={view === "architects"} aria-controls="architects-panel" tabindex={view === "architects" ? 0 : -1} class:on={view === "architects"} onkeydown={flipKey} onclick={() => (view = "architects")}>Architects</button>
	</div>
	<label class="filter">
		<Icon name="users-round" size={14} />
		<input bind:value={filter} placeholder={view === "residents" ? "Filter residents" : "Filter architects"} aria-label={view === "residents" ? "Filter residents" : "Filter architects"} />
	</label>
</div>

{#if !a.connected}
	<div class="unverified">
		<Icon name="circle-help" size={20} />
		<p>Can't verify residents or architects. No live read or last-known snapshot is available.</p>
	</div>
{:else}
	{#if Object.values(data.sources).some((source) => source !== "live")}
		<p class="source-note" role="status">
			<Icon name="radio-tower" size={14} />
			{Object.entries(data.sources).filter(([, state]) => state !== "live").map(([source, state]) => `${source} ${state}`).join(" · ")}
		</p>
	{/if}
	<div class="strip-wrap">
		<FleetStrip summary={a.summary} health={roster.health} />
	</div>

	{#if view === "residents"}
	<div id="residents-panel" class="roster" role="tabpanel" aria-label="Residents">
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
	{:else}
	<div id="architects-panel" class="architects" role="tabpanel" aria-label="Architects">
		{#each architects as architect (architect.host)}
			<section class="architect">
				<header>
					<Icon name="hammer" size={16} />
					<div><h2>Architect · {architect.host}</h2><span>Manager supervisor</span></div>
					<StatusPill tone={managerStale(architect.heartbeat) ? "warn" : stateTone(architect.heartbeat.state)} label={managerStale(architect.heartbeat) ? `stale ${age(Math.floor(Date.parse(architect.heartbeat.observed_at) / 1_000))}` : architect.heartbeat.state.replace("_", " ")} />
				</header>
				<dl>
					<div><dt>PID</dt><dd>{architect.heartbeat.pid}</dd></div>
					<div><dt>Version</dt><dd>{architect.heartbeat.version}</dd></div>
					<div><dt>Uptime</dt><dd>{age(architect.heartbeat.started_at_epoch)}</dd></div>
					<div><dt>Crashes</dt><dd>{architect.heartbeat.crash_count}</dd></div>
					<div><dt>Matrix sync</dt><dd class:danger={architect.heartbeat.last_sync_ok_epoch === 0 || now / 1_000 - architect.heartbeat.last_sync_ok_epoch > 120}>{architect.heartbeat.last_sync_ok_epoch === 0 ? "never" : `${age(architect.heartbeat.last_sync_ok_epoch)} ago`}</dd></div>
					<div><dt>Observed</dt><dd>{new Date(architect.heartbeat.observed_at).toLocaleTimeString()}</dd></div>
				</dl>
				<div class="residents"><span>Residents</span>{#each architect.residents as resident}<a href="/agents?agent={resident}">{resident}</a>{:else}<em>No resident handle reported</em>{/each}</div>
				<p>Architect present. Supervising {architect.residents.length} resident{architect.residents.length === 1 ? "" : "s"}.</p>
			</section>
		{:else}
			<div class="unverified"><Icon name="circle-help" size={20} /><p>{data.sources.managers === "unavailable" ? "Manager heartbeat read unavailable." : "No manager heartbeats are visible."}</p></div>
		{/each}
	</div>
	{/if}
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
	.flip {
		display: inline-flex;
		background: var(--s2);
		border-radius: var(--r-pill);
		padding: 2px;
		margin-inline-start: auto;
	}
	.flip button {
		min-height: 32px;
		padding: 0 var(--s-3);
		border: 0;
		border-radius: var(--r-pill);
		background: transparent;
		color: var(--text-2);
		font: 500 0.75rem var(--sans);
		transition: background var(--t), color var(--t);
	}
	.flip button.on { background: var(--petal-soft); color: var(--text); }
	.flip button:focus-visible { outline: 2px solid var(--petal); outline-offset: 2px; }
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
	.source-note {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		margin-top: var(--s-3);
		color: var(--warn-text);
		font: 500 0.75rem var(--mono);
	}
	.architects {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(464px, 100%), 1fr));
		gap: var(--s-3);
		margin-top: var(--s-4);
	}
	.architect { background: var(--s1); border-radius: var(--r-xs); padding: var(--s-4); }
	.architect header { display: flex; align-items: center; gap: var(--s-2); }
	.architect header > div { flex: 1; }
	.architect h2 { margin: 0; font: 500 0.875rem var(--sans); color: var(--text); }
	.architect header span, .architect p { color: var(--jade-text); font-size: 0.75rem; }
	.architect dl { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--s-3); margin: var(--s-4) 0; }
	.architect dl div { min-width: 0; }
	.architect dt { color: var(--text-3); font: 500 0.6875rem var(--mono); }
	.architect dd { margin: 2px 0 0; color: var(--text-2); font: 500 0.75rem var(--mono); overflow-wrap: anywhere; }
	.architect dd.danger { color: var(--danger-text); }
	.residents { display: flex; align-items: center; flex-wrap: wrap; gap: var(--s-2); padding-top: var(--s-3); border-top: 1px solid var(--rule); }
	.residents span { color: var(--text-3); font: 500 0.6875rem var(--mono); }
	.residents a { min-height: 32px; display: inline-flex; align-items: center; padding: 0 var(--s-2); border-radius: var(--r-pill); background: var(--s2); color: var(--text-2); font: 500 0.6875rem var(--mono); text-decoration: none; }
	.residents a:focus-visible { outline: 2px solid var(--petal); outline-offset: 2px; }
	.residents em { color: var(--text-3); font-size: 0.75rem; }
	@media (max-width: 700px) { .flip { order: 3; margin-inline-start: 0; } .architect dl { grid-template-columns: repeat(2, 1fr); } }
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
