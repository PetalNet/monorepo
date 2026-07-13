<script lang="ts">
	import type { HealthVerdict } from "$lib/api/derive";
	import Icon from "./Icon.svelte";
	import HudChip from "./HudChip.svelte";

	/**
	 * SurfaceSign (foundations §3.7): sign-face title + jade fine line + optional
	 * HUD chips, the 40px signage row. On the cockpit the fine line is the facade
	 * honesty hero — the exact pilot string renders ONLY on positive evidence
	 * (§4.6); a P0 fractures it, silence shows "Can't verify".
	 */
	export interface Hud {
		tone: "good" | "warn" | "danger" | "info" | "idle";
		count: number | string;
		label: string;
	}
	interface Props {
		title: string;
		/** hero = the 32px cockpit greeting; else surface sign-small. */
		hero?: boolean;
		verdict?: HealthVerdict | null;
		stateFact?: string | null;
		date?: string | null;
		hud?: Hud[];
	}
	let { title, hero = false, verdict = null, stateFact = null, date = null, hud = [] }: Props =
		$props();
</script>

<div class="sign-row" class:hero>
	<h1 class:hero>{title}</h1>

	{#if verdict}
		<span class="fine {verdict}">
			{#if verdict === "cracked"}
				<Icon name="triangle-alert" size={14} />{stateFact ?? "Everything is not fine."}
			{:else if verdict === "cant_verify"}
				<Icon name="circle-help" size={14} />{stateFact ?? "Can't verify."}
			{:else if verdict === "needs_you"}
				<Icon name="circle-check" size={14} />Mostly fine. Something needs you.
			{:else}
				<Icon name="circle-check" size={14} />Welcome! Everything is fine.
			{/if}
		</span>
	{/if}

	{#if date}<span class="date">{date}</span>{/if}
</div>

{#if hud.length}
	<div class="hud">
		{#each hud as chip, i (i)}
			<HudChip tone={chip.tone} count={chip.count} label={chip.label} />
		{/each}
	</div>
{/if}

<style>
	.sign-row {
		display: flex;
		align-items: baseline;
		gap: var(--s-3);
		min-height: 40px;
	}
	h1 {
		font:
			400 1.25rem/1.15 var(--sign);
		letter-spacing: -0.012em;
	}
	h1.hero {
		font-size: 2rem;
	}
	.fine {
		font:
			400 0.875rem var(--sign);
		color: var(--jade-text);
		display: inline-flex;
		align-items: center;
		gap: var(--s-1);
	}
	.fine :global(svg) {
		color: var(--jade);
	}
	.fine.cracked {
		color: var(--danger-text);
	}
	.fine.cracked :global(svg) {
		color: var(--danger-dot);
	}
	.fine.cant_verify {
		color: var(--warn-text);
	}
	.fine.cant_verify :global(svg) {
		color: var(--warn-dot);
	}
	.date {
		margin-inline-start: auto;
		font:
			400 0.75rem var(--mono);
		color: var(--text-3);
	}
	.hud {
		display: flex;
		gap: var(--s-2);
		margin-top: var(--s-3);
		flex-wrap: wrap;
	}
</style>
