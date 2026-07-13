<script lang="ts">
	import { humanAge, rosterState, rosterTone } from "$lib/api/derive";
	import { opDef } from "$lib/api/ops";
	import type { RosterItem } from "$lib/api/types";
	import { hueForHandle, initial } from "$lib/util";
	import BudgetLight from "./BudgetLight.svelte";
	import Countdown from "./Countdown.svelte";
	import Icon from "./Icon.svelte";
	import OpButton from "./OpButton.svelte";
	import StatusPill from "./StatusPill.svelte";

	/**
	 * RosterRow (04-agents §3.2): one agent as a live 48px row — who/where/status
	 * + now-playing + governance + lease + the overflow ActionRow. The row never
	 * disables; its ops do (lane-gated + executor-liveness). Presence merges fleet
	 * status with heartbeat state + staleness (a gone-quiet resident is down, not
	 * alive) via the shared derivation.
	 */
	interface Props {
		row: RosterItem;
		lanes: string[];
		now?: number;
	}
	let { row, lanes, now = Date.now() }: Props = $props();

	let menuOpen = $state(false);

	const st = $derived(rosterState(row, now));
	const tone = $derived(rosterTone(st));
	const hollow = $derived(st === "gone_quiet" || st === "alive");
	const pillLabel = $derived(
		st === "rate_limited"
			? "rate limited"
			: st === "gone_quiet"
				? "gone quiet"
				: st.replace("_", " "),
	);
	const nowPlaying = $derived.by(() => {
		if (st === "gone_quiet") return `derived ${Math.round((now - Date.parse(row.fleet_updated_at ?? row.updated_at)) / 1000)}s stale`;
		if (st === "paused") return "Marbleized. Suspended, not destroyed.";
		if (row.status === "idle" || !row.current_tool) return "In the void. Ready when called.";
		const parts = [row.current_tool];
		if (row.task_id) parts.push(`task ${row.task_id}${row.task_title ? ` ${row.task_title}` : ""}`);
		if (row.started_at) parts.push(humanAge(now - Date.parse(row.started_at)));
		return parts.join(" · ");
	});

	const restart = opDef("agent.restart");
	const govAction = opDef("governance.action");
</script>

<div class="row" class:active={menuOpen}>
	<span class="ava" style="background: oklch(var(--avatar-l) var(--avatar-c) {hueForHandle(row.handle)})">
		{initial(row.handle)}
	</span>
	<div class="who">
		<b>{row.handle}</b>
		<span class="meta">{row.host ?? "?"} · {row.lane ?? "—"} · {row.autonomy ?? "—"}</span>
	</div>
	<StatusPill {tone} label={pillLabel} {hollow} pulse={st === "working"} />
	<div class="playing" class:pulse={st === "working"}>{nowPlaying}</div>
	<div class="gov">
		<BudgetLight light={row.light ?? null} />
		{#if row.tier}<span class="tier">{row.tier}</span>{/if}
	</div>
	<div class="lease"><Countdown expiresAt={row.lease_expires_at ?? null} {now} /></div>
	<div class="overflow">
		<button class="ov-btn" aria-label="Actions for {row.handle}" onclick={() => (menuOpen = !menuOpen)}>
			<Icon name="ellipsis" size={16} />
		</button>
		{#if menuOpen}
			<div class="menu" role="menu">
				{#if restart}
					<OpButton def={restart} args={{ handle: row.handle }} {lanes} variant="ghost" />
				{/if}
				{#if govAction}
					<OpButton
						def={govAction}
						args={{ handle: row.handle, action: row.autonomy === "paused" ? "restore" : "pause" }}
						label={row.autonomy === "paused" ? "Restore" : "Pause"}
						{lanes}
						variant="ghost"
					/>
				{/if}
			</div>
		{/if}
	</div>
</div>

<style>
	.row {
		display: grid;
		grid-template-columns: 24px 176px 112px 1fr 96px 72px 40px;
		align-items: center;
		gap: var(--s-2);
		height: 48px;
		padding: 0 var(--s-2);
		border-radius: var(--r-xs);
		transition: background var(--t);
	}
	.row:hover,
	.row.active {
		background: var(--s2);
	}
	.ava {
		width: 24px;
		height: 24px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		font:
			500 0.6875rem var(--sans);
		color: var(--on-avatar);
	}
	.who {
		min-width: 0;
	}
	.who b {
		font:
			500 0.8125rem var(--sans);
		display: block;
	}
	.meta {
		font:
			400 0.6875rem var(--mono);
		color: var(--text-3);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		display: block;
	}
	.playing {
		font:
			400 0.75rem var(--mono);
		color: var(--text-3);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}
	.playing.pulse {
		color: var(--text-2);
	}
	.gov {
		display: inline-flex;
		align-items: center;
		gap: var(--s-1);
	}
	.tier {
		font:
			500 0.6875rem var(--mono);
		color: var(--text-3);
	}
	.lease {
		text-align: end;
	}
	.overflow {
		position: relative;
		display: flex;
		justify-content: flex-end;
	}
	.ov-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border: 0;
		border-radius: var(--r-sm);
		background: transparent;
		color: var(--text-3);
		cursor: pointer;
	}
	.ov-btn:hover {
		background: var(--s3);
	}
	.menu {
		position: absolute;
		top: calc(100% + 2px);
		inset-inline-end: 0;
		z-index: var(--z-dropdown);
		background: var(--s1);
		border-radius: var(--r-xs);
		box-shadow: var(--shadow-pop);
		padding: var(--s-1);
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 140px;
	}
	@media (max-width: 767px) {
		.row {
			grid-template-columns: 24px minmax(0, 1fr) auto;
			grid-template-rows: 24px 16px;
			column-gap: var(--s-2);
			row-gap: 0;
			height: 48px;
			min-width: 0;
			padding: var(--s-1) var(--s-2);
			background: var(--s1);
		}
		.ava {
			grid-column: 1;
			grid-row: 1 / span 2;
		}
		.who {
			grid-column: 2;
			grid-row: 1;
			align-self: end;
		}
		.who b {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.meta {
			display: none;
		}
		.row > :global(.pill) {
			grid-column: 3;
			grid-row: 1 / span 2;
		}
		.playing {
			grid-column: 2;
			grid-row: 2;
			align-self: start;
			font-size: 0.6875rem;
		}
		.gov,
		.lease,
		.overflow {
			display: none;
		}
	}
</style>
