<script lang="ts">
	import { humanAge } from "$lib/api/derive";
	import { opDef } from "$lib/api/ops";
	import type { AttentionItem } from "$lib/api/types";
	import Icon from "./Icon.svelte";
	import OpButton from "./OpButton.svelte";

	/**
	 * AttentionCard (foundations §3.7/§4.4): fact-first reason, source signal, age,
	 * inline fix ActionRow, ack + snooze, blast-radius line for host/service items.
	 * A P0 renders as the facade crack (§4.6): the fact in danger grade, the fix
	 * inline, the blast radius, and the vetted subline. fix_ops carry pre-bound
	 * args — the client never derives op args from subject. The fix leads; the
	 * generic attention controls (ack/snooze/resolve) collapse into an overflow so
	 * the one card you hit at 2am is not a wall of near-identical verbs.
	 */
	interface Props {
		item: AttentionItem;
		lanes: string[];
		/** Executor-liveness per fix op executor kind; missing => assume live. */
		executorLive?: Record<string, boolean>;
		now?: number;
	}
	let { item, lanes, executorLive = {}, now = Date.now() }: Props = $props();

	let moreOpen = $state(false);

	const isCrack = $derived(item.grade === "p0");
	const ackDef = opDef("attention.ack");
	const snoozeDef = opDef("attention.snooze");
	const resolveDef = opDef("attention.resolve");
	const houseHref = $derived(
		item.blast_radius?.host ? `/hosts?host=${item.blast_radius.host}` : null,
	);
</script>

<article class="att" class:crack={isCrack} class:acked={item.acked_by}>
	<div class="head" class:crack={isCrack}>
		{#if isCrack}<Icon name="triangle-alert" size={14} />{/if}
		<span>{item.summary}</span>
	</div>

	<div class="meta">
		{item.source} · {humanAge(now - Date.parse(item.ts))} ago{item.acked_by
			? ` · held by ${item.acked_by}`
			: ""}
	</div>

	{#if item.blast_radius}
		{@const b = item.blast_radius}
		<div class="blast">
			{b.detail ?? "Blast radius"}
			{#if b.leases_expiring_30m}· {b.leases_expiring_30m} lease{b.leases_expiring_30m > 1
					? "s"
					: ""} expiring in 30m{/if}
			{#if houseHref}· <a href={houseHref}>open the house</a>{/if}
		</div>
	{/if}

	<div class="actions">
		{#each item.fix_ops ?? [] as fix, i (i)}
			{@const def = opDef(fix.op)}
			{#if def}
				<OpButton
					{def}
					args={fix.args}
					{lanes}
					executorLive={executorLive[def.executor] ?? true}
					variant={i === 0 ? "primary" : "tonal"}
				/>
			{/if}
		{/each}

		<button
			type="button"
			class="more"
			aria-expanded={moreOpen}
			aria-label="More attention actions"
			onclick={() => (moreOpen = !moreOpen)}
		>
			<Icon name="ellipsis" size={16} />
		</button>

		{#if moreOpen}
			{#if ackDef && !item.acked_by}
				<OpButton def={ackDef} args={{ id: item.id }} {lanes} variant="ghost" />
			{/if}
			{#if snoozeDef}
				<OpButton def={snoozeDef} args={{ id: item.id, duration_s: 3600 }} {lanes} variant="ghost" />
			{/if}
			{#if resolveDef}
				<OpButton def={resolveDef} args={{ id: item.id }} {lanes} variant="ghost" />
			{/if}
		{/if}
	</div>

	{#if isCrack}
		<div class="crack-sub">The facade cracks so you never have to wonder.</div>
	{/if}
</article>

<style>
	.att {
		background: var(--s1);
		border-radius: var(--r-xs);
		padding: var(--s-3) var(--s-4);
	}
	.att.acked {
		opacity: 0.7;
	}
	.head {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		font:
			500 0.875rem var(--sans);
	}
	.head.crack {
		color: var(--danger-text);
	}
	.head.crack :global(svg) {
		color: var(--danger-dot);
	}
	.meta {
		font-size: 0.75rem;
		color: var(--text-3);
		margin-top: var(--s-1);
		font-family: var(--mono);
	}
	.blast {
		font-size: 0.75rem;
		color: var(--text-2);
		margin-top: var(--s-1);
	}
	.blast a {
		color: var(--petal-text);
	}
	.actions {
		display: flex;
		gap: var(--s-2);
		margin-top: var(--s-2);
		flex-wrap: wrap;
		align-items: center;
	}
	.more {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border: 0;
		border-radius: var(--r-sm);
		background: transparent;
		color: var(--text-3);
		cursor: pointer;
		transition: background var(--t);
	}
	.more:hover {
		background: var(--s2);
	}
	.crack-sub {
		font:
			400 0.75rem var(--sans);
		color: var(--text-3);
		margin-top: var(--s-2);
	}
</style>
