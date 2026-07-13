<script lang="ts">
	import { humanAge } from "$lib/api/derive";
	import type { UpdateRowView } from "$lib/data/updates";
	import { clockNow } from "$lib/stores/clock.svelte";
	import ApplyModeChip from "./ApplyModeChip.svelte";
	import StatusPill from "./StatusPill.svelte";

	/**
	 * UpdateRow (09-updates §3.1): one box's update posture. A null count renders
	 * "—", never 0 (a null is not a zero). A stale row watermarks "not verified"
	 * regardless of stored status — a stale "Up to date" is never allowed to look
	 * fine.
	 */
	interface Props {
		row: UpdateRowView;
	}
	let { row }: Props = $props();
	const now = $derived(clockNow());

	const pill = $derived(
		row.status === "up_to_date"
			? { tone: "good" as const, label: "Up to date" }
			: row.status === "updates_pending"
				? { tone: "info" as const, label: "Pending" }
				: row.status === "updates_overdue"
					? { tone: "warn" as const, label: "Overdue" }
					: { tone: "danger" as const, label: "Can't collect" },
	);
	const num = (n: number | null) => (n == null ? "—" : String(n));
	const ago = (ts: string | null) => (ts ? humanAge(now - Date.parse(ts)) : "—");
</script>

<div class="row" class:trouble={row.securityCritical}>
	<span class="host">{row.host}</span>
	<span class="pill">
		<StatusPill tone={pill.tone} label={pill.label} />
		{#if row.stale}<span class="stale">not verified</span>{/if}
	</span>
	<span class="n">{num(row.pending)}</span>
	<span class="n sec" class:danger={row.securityCritical}>{num(row.securityCritical)}</span>
	<span class="n">{num(row.vulns)}</span>
	<span class="n reboot">{row.rebootRequired == null ? "—" : row.rebootRequired ? "reboot" : "no"}</span>
	<span class="mode"><ApplyModeChip mode={row.applyMode} /></span>
	<span class="n dim">{ago(row.lastChecked)}</span>
	<span class="n dim">{ago(row.lastApplied)}</span>
	<span class="src">{row.source}{row.agentless ? " · agentless" : ""}</span>
</div>

<style>
	.row {
		display: grid;
		grid-template-columns: 88px 150px 56px 64px 52px 64px 132px 64px 64px 1fr;
		align-items: center;
		gap: var(--s-2);
		height: 40px;
		padding: 0 var(--s-2);
		border-top: 1px solid var(--rule);
		transition: background var(--t);
	}
	.row:hover {
		background: var(--s2);
	}
	.host {
		font:
			500 0.8125rem var(--mono);
	}
	.pill {
		display: inline-flex;
		align-items: center;
		gap: var(--s-1);
	}
	.stale {
		font:
			400 0.625rem var(--mono);
		color: var(--warn-text);
	}
	.n {
		font:
			500 0.75rem var(--mono);
		font-feature-settings: "tnum" 1;
		color: var(--text-2);
	}
	.n.dim {
		color: var(--text-3);
	}
	.sec.danger {
		color: var(--danger-text);
	}
	.reboot {
		color: var(--text-3);
	}
	.src {
		font:
			400 0.6875rem var(--mono);
		color: var(--text-3);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
