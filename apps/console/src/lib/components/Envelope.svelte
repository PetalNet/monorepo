<script lang="ts">
	import { humanAge } from "$lib/api/derive";
	import type { CommsEvent } from "$lib/api/types";
	import Icon from "./Icon.svelte";

	/**
	 * The letter (foundations §4.5, /task/714): a small envelope, sender → recipient.
	 * A pure renderer over bus comms events (card/rpc/mail). Honest under load: an
	 * aggregate stream line with a mono count instead of a swarm. Clickable to its
	 * comms-log entry. Never loops at idle.
	 */
	interface Props {
		event: CommsEvent;
		/** Aggregate form: a per-minute rate instead of one letter. */
		rate?: number | null;
		now?: number;
	}
	let { event, rate = null, now = Date.now() }: Props = $props();
	const kind = $derived(
		event.method === "comms.card" ? "task-card" : event.method === "comms.rpc" ? "rpc" : "mail",
	);
	const href = $derived(event.card_id ? `/signals?card=${event.card_id}` : "/signals");
</script>

<a class="mail-row" {href}>
	{#if rate}
		<Icon name="mails" size={12} />
	{:else}
		<Icon name="mail" size={12} />
	{/if}
	<span class="route">{event.sender} → {event.recipient}</span>
	{#if rate}
		<span class="count">{rate}/min</span>
	{:else}
		<span class="kind">{kind}{event.task_id ? ` · /task/${event.task_id}` : ""}</span>
	{/if}
	<time>{rate ? "now" : humanAge(now - Date.parse(event.ts))}</time>
</a>

<style>
	.mail-row {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		font-size: 0.75rem;
		color: var(--text-2);
		padding: var(--s-1) 0;
		border-top: 1px solid var(--rule);
		text-decoration: none;
	}
	.mail-row:first-of-type {
		border-top: 0;
	}
	.mail-row :global(svg) {
		color: var(--petal);
		flex: none;
	}
	.route {
		font-family: var(--mono);
		font-size: 0.6875rem;
	}
	.kind {
		font-family: var(--mono);
		font-size: 0.6875rem;
		color: var(--text-3);
	}
	.count {
		font:
			500 0.75rem var(--mono);
		font-feature-settings: "tnum" 1;
		color: var(--text-2);
	}
	time {
		margin-inline-start: auto;
		color: var(--text-3);
		font-size: 0.6875rem;
	}
</style>
