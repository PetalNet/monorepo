<script lang="ts">
	import StatusDot from "./StatusDot.svelte";

	/** HUD chip (foundations §3.7): pill, dot + tabular count + label. */
	interface Props {
		tone?: "good" | "warn" | "danger" | "info" | "idle";
		count: number | string;
		label: string;
	}
	let { tone = "idle", count, label }: Props = $props();
</script>

<span class="hud-chip">
	<StatusDot {tone} />
	<b>{count}</b>
	<span class="lbl">{label}</span>
</span>

<style>
	.hud-chip {
		display: inline-flex;
		align-items: center;
		gap: var(--s-2);
		background: var(--s1);
		border-radius: var(--r-pill);
		padding: var(--s-1) var(--s-3) var(--s-1) var(--s-2);
		min-height: 32px;
	}
	b {
		font:
			500 1rem var(--mono);
		font-feature-settings: "tnum" 1;
	}
	.lbl {
		font-size: 0.75rem;
		color: var(--text-3);
	}
</style>
