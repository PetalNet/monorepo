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

<div class="strip desktop-strip">
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

<div class="phone-strip" aria-label="Fleet summary">
	<span class="phone-health" class:danger={health.down > 0}>
		<StatusDot tone={health.down > 0 ? "danger" : "good"} />
		<span class="health-long" aria-hidden="true">{health.alive} alive · {health.working} working · {health.idle} idle · {health.down} down</span>
		<span class="health-short" aria-hidden="true">{health.alive}A · {health.working}W · {health.idle}I · {health.down}D</span>
		<span class="sr-only">{health.alive} alive, {health.working} working, {health.idle} idle, {health.down} down</span>
	</span>
	<span class="phone-budget">
		<BudgetLight {light} /><span class="sr-only">Fleet points used: </span>{pct}%
	</span>
	<span class="phone-mode">{summary.mode === "parallel" ? "Parallel" : "Sequential"}</span>
</div>

<style>
	.phone-strip {
		display: none;
	}
	.health-short {
		display: none;
	}
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
	@media (max-width: 767px) {
		.desktop-strip {
			display: none;
		}
		.phone-strip {
			display: flex;
			align-items: center;
			gap: var(--s-2);
			min-height: 40px;
			padding: 0 var(--s-2);
			background: var(--s1);
			border-radius: var(--r-xs);
			font: 500 0.6875rem var(--mono);
			font-feature-settings: "tnum" 1;
			color: var(--text-2);
			white-space: nowrap;
		}
		.phone-health {
			display: inline-flex;
			align-items: center;
			gap: var(--s-1);
			min-width: 0;
		}
		.phone-health.danger {
			color: var(--danger-text);
		}
		.phone-budget {
			display: inline-flex;
			align-items: center;
			gap: var(--s-1);
			margin-inline-start: auto;
		}
		.phone-mode {
			color: var(--text-3);
		}
	}
	@media (max-width: 430px) {
		.phone-strip {
			gap: var(--s-1);
			font-size: 0.625rem;
		}
		.phone-health {
			gap: 2px;
		}
		.health-long {
			display: none;
		}
		.health-short {
			display: inline;
		}
	}
</style>
