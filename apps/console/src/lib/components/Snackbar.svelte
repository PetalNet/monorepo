<script lang="ts">
	import { runOp } from "$lib/api/client";
	import { snackbar } from "$lib/stores/snackbar.svelte";
	import Icon from "./Icon.svelte";

	/**
	 * Snackbar host (foundations §2.1/§4.2): bottom-left, capped at 2 visible + a
	 * "N more" collapse, clear of the centered dock. Every fired op lands here with
	 * the op name and an undo where the op supports it.
	 */
	const MAX_VISIBLE = 2;
	const visible = $derived(snackbar.items.slice(-MAX_VISIBLE));
	const hidden = $derived(Math.max(0, snackbar.items.length - MAX_VISIBLE));

	async function undo(id: number, u: { op: string; args: Record<string, unknown> }) {
		snackbar.dismiss(id);
		await runOp(u.op, u.args);
		snackbar.push({ message: `${u.op} sent`, op: u.op, tone: "good" });
	}
</script>

<div class="snack-stack" aria-live="polite">
	{#if hidden > 0}
		<div class="more">{hidden} more</div>
	{/if}
	{#each visible as s (s.id)}
		<div class="snack {s.tone}" role="status">
			<Icon name={s.tone === "danger" ? "triangle-alert" : "circle-check"} size={14} />
			<span>{s.message}</span>
			{#if s.undo}
				<button onclick={() => undo(s.id, s.undo!)}>Undo</button>
			{/if}
		</div>
	{/each}
</div>

<style>
	.snack-stack {
		position: fixed;
		inset-inline-start: var(--s-3);
		bottom: var(--s-3);
		z-index: var(--z-snackbar);
		display: flex;
		flex-direction: column;
		gap: var(--s-2);
		align-items: flex-start;
	}
	.more {
		font:
			500 0.6875rem var(--mono);
		color: var(--text-3);
		background: var(--s2);
		border-radius: var(--r-xs);
		padding: 2px var(--s-2);
	}
	.snack {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		background: var(--s2);
		border-radius: var(--r-sm);
		padding: var(--s-2) var(--s-3);
		box-shadow: inset 0 0 0 1px var(--rule-strong);
		font-size: 0.8125rem;
		width: max-content;
		max-width: 90vw;
		animation: rise var(--dur-mid) var(--ease-standard) both;
	}
	.snack :global(svg) {
		color: var(--good-dot);
		flex: none;
	}
	.snack.danger :global(svg) {
		color: var(--danger-dot);
	}
	.snack button {
		color: var(--petal-text);
		font-weight: 500;
		background: none;
		border: 0;
		cursor: pointer;
		margin-inline-start: var(--s-2);
		font-size: 0.8125rem;
	}
	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.snack {
			animation: none;
		}
	}
</style>
