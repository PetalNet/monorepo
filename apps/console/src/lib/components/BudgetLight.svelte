<script lang="ts">
	import type { BudgetLightColor } from "$lib/api/types";

	/**
	 * BudgetLight (foundations §3.7): a traffic light (green/yellow/red at 70/90%)
	 * plus optional tokens-spent mono. The light is the primary signal; grade is
	 * governance-served (§6.2), never re-derived from a percent client-side.
	 */
	interface Props {
		light: BudgetLightColor | null;
		label?: string | null;
	}
	let { light, label = null }: Props = $props();
</script>

<span class="bl" title={light ? `budget ${light}` : "no grant"}>
	<span class="lamp g" class:on={light === "green"}></span>
	<span class="lamp y" class:on={light === "yellow"}></span>
	<span class="lamp r" class:on={light === "red"}></span>
	{#if label}<span class="lbl">{label}</span>{/if}
</span>

<style>
	.bl {
		display: inline-flex;
		align-items: center;
		gap: var(--s-1);
	}
	.lamp {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--s3);
	}
	.lamp.g.on {
		background: var(--good-dot);
	}
	.lamp.y.on {
		background: var(--warn-dot);
	}
	.lamp.r.on {
		background: var(--danger-dot);
	}
	.lbl {
		font:
			500 0.75rem var(--mono);
		font-feature-settings: "tnum" 1;
		color: var(--text-2);
		margin-inline-start: var(--s-1);
	}
</style>
