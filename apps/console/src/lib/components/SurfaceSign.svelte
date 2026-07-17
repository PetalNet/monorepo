<script lang="ts">
	import type { HealthVerdict } from "$lib/api/derive";
	import { opDef } from "$lib/api/ops";
	import type { AttentionItem } from "$lib/api/types";
	import Icon from "./Icon.svelte";
	import HudChip from "./HudChip.svelte";
	import OpButton from "./OpButton.svelte";

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
	type FixOp = NonNullable<AttentionItem["fix_ops"]>[number];
	interface Props {
		title: string;
		/** hero = the 32px cockpit greeting; else surface sign-small. */
		hero?: boolean;
		verdict?: HealthVerdict | null;
		stateFact?: string | null;
		crackMeta?: string | null;
		crackLead?: FixOp;
		lanes?: string[];
		date?: string | null;
		hud?: Hud[];
	}
	let {
		title,
		hero = false,
		verdict = null,
		stateFact = null,
		crackMeta = null,
		crackLead,
		lanes = [],
		date = null,
		hud = [],
	}: Props = $props();
	const leadDef = $derived(crackLead ? opDef(crackLead.op) : null);
	const crackFact = $derived(
		stateFact?.includes("Everything is not fine")
			? stateFact
			: `Everything is not fine.${stateFact ? ` ${stateFact}` : ""}`,
	);
</script>

{#if hero && verdict === "cracked"}
	<div class="crack-row" role="status" aria-live="polite">
		<div class="crack-hero">
			<div class="crack-head"><Icon name="triangle-alert" size={18} /><span>{crackFact}</span></div>
			{#if crackMeta}<div class="crack-meta">{crackMeta}</div>{/if}
			<div class="crack-sub">The facade cracks so you never have to wonder.</div>
			{#if leadDef && crackLead}
				<div class="crack-action"><OpButton def={leadDef} args={crackLead.args} {lanes} variant="primary" /></div>
			{/if}
		</div>
		{#if date}<span class="date">{date}</span>{/if}
	</div>
{:else}
	<div class="sign-row" class:hero>
		<h1 class:hero>{title}</h1>

		{#if verdict}
			<span class="fine {verdict}">
				{#if verdict === "cracked"}
					<Icon name="triangle-alert" size={14} />{stateFact ?? "Everything is not fine."}
				{:else if verdict === "cant_verify"}
					<Icon name="circle-help" size={14} />{stateFact ?? "Can't verify."}
				{:else if verdict === "needs_you"}
					<Icon name="circle-help" size={14} />{stateFact ?? "Mostly fine. Something needs you."}
				{:else}
					<Icon name="circle-check" size={14} />Welcome! Everything is fine.
				{/if}
			</span>
		{/if}

		{#if date}<span class="date">{date}</span>{/if}
	</div>
{/if}

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
	.crack-row {
		display: flex;
		align-items: flex-start;
		gap: var(--s-3);
		min-height: 72px;
		background: var(--s1);
		border-radius: var(--r-xs);
		padding: var(--s-3) var(--s-4);
		animation: crack-open 360ms var(--ease-standard) both;
	}
	.crack-hero { min-width: 0; }
	.crack-head {
		display: flex;
		align-items: flex-start;
		gap: var(--s-2);
		color: var(--danger-text);
		font: 400 1.25rem/1.3 var(--sign);
		text-wrap: pretty;
	}
	.crack-head :global(svg) { color: var(--danger-dot); flex: none; margin-top: 4px; }
	.crack-sub { margin-top: var(--s-1); color: var(--text-3); font: 400 0.75rem var(--sans); }
	.crack-meta { margin-top: var(--s-1); color: var(--text-2); font: 500 0.6875rem var(--mono); }
	.crack-action { margin-top: var(--s-2); }
	@keyframes crack-open {
		0% { opacity: 0.72; clip-path: polygon(0 0, 48% 0, 50% 45%, 52% 0, 100% 0, 100% 100%, 52% 100%, 50% 55%, 48% 100%, 0 100%); }
		100% { opacity: 1; clip-path: inset(0); }
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
	/* needs_you is not "fine" — neutral/attention tone, never a green motif. */
	.fine.needs_you {
		color: var(--text-2);
	}
	.fine.needs_you :global(svg) {
		color: var(--text-3);
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
	/* Phone: greeting condenses to one line, date dropped (foundations §2.1). */
	@media (max-width: 767px) {
		.date {
			display: none;
		}
		h1.hero {
			font-size: 1.5rem;
		}
		.crack-row { min-height: 64px; padding: var(--s-3); }
		.crack-head { font-size: 1.125rem; }
	}
	@media (prefers-reduced-motion: reduce) { .crack-row { animation: none; } }
</style>
