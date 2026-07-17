<script lang="ts">
	import type { PageProps } from "./$types";
	import { page } from "$app/state";
	import { onMount } from "svelte";
	import type { HeartbeatItem, RosterItem } from "$lib/api/types";
	import FleetStrip from "$lib/components/FleetStrip.svelte";
	import Icon from "$lib/components/Icon.svelte";
	import IconButton from "$lib/components/IconButton.svelte";
	import ModalSurface from "$lib/components/ModalSurface.svelte";
	import PTYView from "$lib/components/PTYView.svelte";
	import RosterRow from "$lib/components/RosterRow.svelte";
	import SurfaceSign from "$lib/components/SurfaceSign.svelte";
	import StatusPill from "$lib/components/StatusPill.svelte";
	import { deriveRoster } from "$lib/data/agents";
	import { clockNow } from "$lib/stores/clock.svelte";
	import CommsLog from "./CommsLog.svelte";
	import { closeTerminalPeek, openTerminalPeek, pollTerminalPeek } from "./terminal-peek.remote";

	let { data }: PageProps = $props();
	const a = $derived(data.agents);
	// Live clock: countdowns tick and gone-quiet crosses its window without a refresh.
	const now = $derived(clockNow());
	const roster = $derived(deriveRoster(a.roster, now));

	let filter = $state(page.url.searchParams.get("agent") ?? "");
	let view = $state<"residents" | "architects">("residents");
	let correspondenceOpen = $state(page.url.searchParams.has("comms"));
	let peekSession = $state<HeartbeatItem | null>(null);
	let peekDialog = $state<HTMLDialogElement | null>(null);
	let peekStreamId = $state<string | null>(null);
	let peekLines = $state<string[]>([]);
	let peekSeq = $state(0);
	let peekState = $state<"connecting" | "live" | "stalled" | "ended" | "error">("connecting");
	let peekError = $state<string | null>(null);
	let peekGeneration = 0;
	let pollTimer: ReturnType<typeof setTimeout> | null = null;
	let stallTimer: ReturnType<typeof setTimeout> | null = null;
	const decoder = new TextDecoder();
	const canPeek = $derived(data.me.lanes.includes("term_admin"));
	const residentSessions = $derived.by(() => {
		const sessions = new Map<string, HeartbeatItem>();
		for (const heartbeat of data.architects) {
			if (heartbeat.handle && heartbeat.tmux_session && heartbeat.pane_id)
				sessions.set(heartbeat.handle, heartbeat);
		}
		return sessions;
	});
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
		return seconds < 60 ? `${String(seconds)}s` : `${String(Math.floor(seconds / 60))}m`;
	}
	function managerStale(heartbeat: HeartbeatItem): boolean {
		return now - Date.parse(heartbeat.observed_at) > 90_000;
	}
	function peekDisabledReason(heartbeat: HeartbeatItem): string | null {
		if (now - Date.parse(heartbeat.observed_at) > 300_000) return "Manager command lane is not answering";
		if (!heartbeat.io_ok) return "Resident pane I/O is unavailable";
		return null;
	}
	function flipKey(event: KeyboardEvent) {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		event.preventDefault();
		view = view === "residents" ? "architects" : "residents";
		(event.currentTarget as HTMLElement).parentElement?.querySelector<HTMLElement>(`[data-view="${view}"]`)?.focus();
	}
	function decodeSnapshot(encoded: string): string[] {
		const raw = atob(encoded);
		return decoder.decode(Uint8Array.from(raw, (character) => character.charCodeAt(0))).split("\n").slice(-10_000);
	}
	function schedulePoll(generation: number) {
		pollTimer = setTimeout(() => void pollPeek(generation), 1_000);
	}
	async function pollPeek(generation: number) {
		if (generation !== peekGeneration || !peekStreamId) return;
		stallTimer = setTimeout(() => {
			if (generation === peekGeneration) peekState = "stalled";
		}, 5_000);
		try {
			const snapshot = await pollTerminalPeek({ stream_id: peekStreamId, tick: peekSeq });
			if (generation !== peekGeneration) return;
			if (stallTimer) clearTimeout(stallTimer);
			stallTimer = null;
			peekLines = decodeSnapshot(snapshot.data_b64);
			peekSeq = snapshot.seq;
			peekState = "live";
			peekError = null;
			schedulePoll(generation);
		} catch (cause) {
			if (generation !== peekGeneration) return;
			if (stallTimer) clearTimeout(stallTimer);
			stallTimer = null;
			peekState = "error";
			peekError = cause instanceof Error ? cause.message : "pty_unavailable";
		}
	}
	async function watchSession(session: HeartbeatItem) {
		await closePeek();
		peekSession = session;
		peekState = "connecting";
		peekLines = [];
		peekSeq = 0;
		peekError = null;
		const generation = ++peekGeneration;
		try {
			const snapshot = await openTerminalPeek({ host: session.host, tmux_session: session.tmux_session!, pane_id: session.pane_id! });
			if (generation !== peekGeneration) {
				await closeTerminalPeek({ stream_id: snapshot.stream_id }).catch(() => undefined);
				return;
			}
			peekStreamId = snapshot.stream_id;
			peekSeq = snapshot.seq;
			peekLines = decodeSnapshot(snapshot.data_b64);
			peekState = "live";
			schedulePoll(generation);
		} catch (cause) {
			if (generation !== peekGeneration) return;
			peekState = "error";
			peekError = cause instanceof Error ? cause.message : "pty_unavailable";
		}
	}
	async function closePeek() {
		peekGeneration += 1;
		if (pollTimer) clearTimeout(pollTimer);
		if (stallTimer) clearTimeout(stallTimer);
		pollTimer = null;
		stallTimer = null;
		const streamId = peekStreamId;
		peekStreamId = null;
		peekSession = null;
		if (streamId) await closeTerminalPeek({ stream_id: streamId }).catch(() => undefined);
	}
	onMount(() => () => {
		peekGeneration += 1;
		if (pollTimer) clearTimeout(pollTimer);
		if (stallTimer) clearTimeout(stallTimer);
		if (peekStreamId) void closeTerminalPeek({ stream_id: peekStreamId }).catch(() => undefined);
	});
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
	<button
		type="button"
		class="correspondence-toggle"
		class:on={correspondenceOpen}
		aria-expanded={correspondenceOpen}
		aria-controls="correspondence-region"
		title={correspondenceOpen ? "Close Correspondence" : "Open Correspondence"}
		onclick={() => (correspondenceOpen = !correspondenceOpen)}
	>
		<Icon name="mailbox" size={16} />
		<span>Correspondence</span>
	</button>
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
					{@const residentSession = canPeek ? residentSessions.get(row.handle) : null}
					<RosterRow {row} lanes={data.me.lanes} {now} session={residentSession} peekDisabledReason={residentSession ? peekDisabledReason(residentSession) : null} onwatch={watchSession} />
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
				<div class="residents"><span>Residents</span>{#each architect.residents as resident, __eachKey18 (__eachKey18)}<a href="/agents?agent={resident}">{resident}</a>{:else}<em>No resident handle reported</em>{/each}</div>
				<footer class="architect-foot"><p>Architect present. Supervising {architect.residents.length} resident{architect.residents.length === 1 ? "" : "s"}.</p>{#if canPeek && architect.heartbeat.tmux_session && architect.heartbeat.pane_id}<button type="button" disabled={peekDisabledReason(architect.heartbeat) !== null} title={peekDisabledReason(architect.heartbeat) ?? "Watch read-only terminal"} onclick={() => watchSession(architect.heartbeat)}><Icon name="eye" size={13} />Watch session</button>{/if}</footer>
			</section>
		{:else}
			<div class="unverified"><Icon name="circle-help" size={20} /><p>{data.sources.managers === "unavailable" ? "Manager heartbeat read unavailable." : "No manager heartbeats are visible."}</p></div>
		{/each}
	</div>
	{/if}
{/if}

{#if correspondenceOpen}
	<div id="correspondence-region"><CommsLog /></div>
{/if}

<ModalSurface bind:element={peekDialog} open={peekSession !== null} variant="drawer" size="wide" labelledby="terminal-peek-title" onclose={closePeek}>
	{#if peekSession}
		<div class="peek-drawer">
			<IconButton class="dialog-close" name="x" label="Close terminal peek" autofocus onclick={() => peekDialog?.close()} />
			<div class="peek-title"><Icon name="eye" size={16} /><div><h2 id="terminal-peek-title">Watch {peekSession.handle ?? "resident"}</h2><p>Read-only live terminal</p></div></div>
			<PTYView session={peekSession} lines={peekLines} state={peekState} seq={peekSeq} errorCode={peekError} onretry={() => watchSession(peekSession!)} />
		</div>
	{/if}
</ModalSurface>

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
	.filter:focus-within {
		box-shadow: 0 0 0 2px var(--petal);
	}
	.correspondence-toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--s-2);
		min-height: 32px;
		padding: 0 var(--s-2);
		border: 0;
		border-radius: var(--r-sm);
		background: transparent;
		color: var(--text-2);
		font: 500 0.75rem var(--sans);
		transition: background var(--t), color var(--t);
	}
	.correspondence-toggle:hover { background: var(--s2); color: var(--text); }
	.correspondence-toggle.on { background: var(--petal-soft); color: var(--petal-text); }
	.correspondence-toggle:focus-visible { outline: 2px solid var(--petal); outline-offset: 2px; }
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
	.architect-foot { display: flex; align-items: center; gap: var(--s-2); margin-top: var(--s-2); }
	.architect-foot p { margin: 0; flex: 1; }
	.architect-foot button { min-height: 32px; padding: 0 var(--s-2); border: 0; border-radius: var(--r-sm); background: transparent; color: var(--text); display: inline-flex; align-items: center; gap: var(--s-1); font: 500 0.75rem var(--sans); }
	.architect-foot button:hover { background: var(--s2); }
	.architect-foot button:disabled { color: var(--text-3); cursor: not-allowed; }
	.architect-foot button:focus-visible { outline: 2px solid var(--petal); outline-offset: 2px; }
	.residents { display: flex; align-items: center; flex-wrap: wrap; gap: var(--s-2); padding-top: var(--s-3); border-top: 1px solid var(--rule); }
	.residents span { color: var(--text-3); font: 500 0.6875rem var(--mono); }
	.residents a { min-height: 32px; display: inline-flex; align-items: center; padding: 0 var(--s-2); border-radius: var(--r-pill); background: var(--s2); color: var(--text-2); font: 500 0.6875rem var(--mono); text-decoration: none; }
	.residents a:focus-visible { outline: 2px solid var(--petal); outline-offset: 2px; }
	.residents em { color: var(--text-3); font-size: 0.75rem; }
	@media (max-width: 767px) {
		.util { align-items: flex-start; }
		.flip { order: 3; margin-inline-start: 0; }
		.filter { width: 100%; order: 4; }
		.correspondence-toggle { margin-inline-start: auto; }
		.architects { grid-template-columns: 1fr; gap: var(--s-2); }
		.architect { padding: var(--s-3); }
		.architect dl { grid-template-columns: repeat(2, 1fr); margin: var(--s-3) 0; }
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
	.peek-drawer { display: grid; gap: var(--s-4); min-width: 0; }
	.peek-title { min-height: 40px; display: flex; align-items: center; gap: var(--s-2); padding-right: var(--s-5); }
	.peek-title h2 { margin: 0; font: 500 0.875rem var(--sans); }
	.peek-title p { margin: 2px 0 0; color: var(--text-3); font: 400 0.6875rem var(--mono); }
</style>
