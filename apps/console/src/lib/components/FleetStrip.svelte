<script lang="ts">
	import type { FleetSummary } from "$lib/data/mock";
	import { compactTokens } from "$lib/util";
	import BudgetLight from "./BudgetLight.svelte";
	import StatusDot from "./StatusDot.svelte";

	/**
	 * FleetStrip (04-agents §3.1, /task/716): the whole-fleet glance — budget pool,
	 * fleet mode, aggregate health, discipline. Four hairline-separated zones. Down
	 * turns the health pair danger. Mode is a real op (fleet.mode) — read-only here
	 * until the command is wired (operator lane); rendered as state, not a fake toggle.
	 */
	interface Props {
		summary: FleetSummary;
		health: { alive: number; working: number; idle: number; down: number };
	}
	let { summary, health }: Props = $props();

	const pct = $derived(Math.round((summary.tokensSpent / summary.tokensGranted) * 100));
	const light = $derived(pct >= 90 ? "red" : pct >= 70 ? "yellow" : "green");
</script>

<div class="strip">
	<div class="zone">
		<span class="micro">Points</span>
		<span class="val">
			<BudgetLight {light} />
			{pct}% · {compactTokens(summary.tokensSpent)} of {compactTokens(summary.tokensGranted)}
		</span>
	</div>
	<div class="zone">
		<span class="micro">Mode</span>
		<span class="val seg">
			<span class="opt" class:on={summary.mode === "parallel"}>Parallel</span>
			<span class="opt" class:on={summary.mode === "sequential"}>Sequential</span>
			{#if summary.modeReason}<span class="reason">{summary.modeReason}</span>{/if}
		</span>
	</div>
	<div class="zone">
		<span class="micro">Health</span>
		<span class="val" class:danger={health.down > 0}>
			<StatusDot tone="good" />{health.alive} alive · <StatusDot tone="good" />{health.working} working
			· <StatusDot tone="idle" />{health.idle} idle ·
			<StatusDot tone={health.down > 0 ? "danger" : "idle"} />{health.down} down
		</span>
	</div>
	<div class="zone">
		<span class="micro">Discipline</span>
		<span class="val" class:warn={summary.disciplineOffTask > 0}>
			{summary.disciplineNote ?? "All on task."}
		</span>
	</div>
</div>

<style>
	.strip {
		display: grid;
		grid-template-columns: repeat(4, auto);
		gap: 0;
		background: var(--s1);
		border-radius: var(--r-xs);
		min-height: 56px;
		align-items: stretch;
		width: max-content;
		max-width: 100%;
		overflow-x: auto;
	}
	.zone {
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 2px;
		padding: var(--s-2) var(--s-3);
		border-inline-start: 1px solid var(--rule);
	}
	.zone:first-child {
		border-inline-start: 0;
	}
	.val {
		display: inline-flex;
		align-items: center;
		gap: var(--s-1);
		font:
			500 0.8125rem var(--mono);
		font-feature-settings: "tnum" 1;
		color: var(--text-2);
		white-space: nowrap;
	}
	.val.danger {
		color: var(--danger-text);
	}
	.val.warn {
		color: var(--warn-text);
	}
	.seg {
		background: var(--s2);
		border-radius: var(--r-pill);
		padding: 2px;
		gap: 0;
	}
	.opt {
		font:
			500 0.6875rem var(--sans);
		padding: 2px var(--s-2);
		border-radius: var(--r-pill);
		color: var(--text-3);
	}
	.opt.on {
		background: var(--petal-soft);
		color: var(--petal-text);
	}
	.reason {
		font:
			400 0.6875rem var(--mono);
		color: var(--text-3);
		margin-inline-start: var(--s-1);
	}
</style>
