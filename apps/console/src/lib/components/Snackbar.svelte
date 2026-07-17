<script lang="ts">
	import { runOp } from "$lib/rpc/browser";
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
	let host = $state<HTMLDivElement | null>(null);
	let popoverRevision = 0;

	// A native modal dialog occupies the browser top layer. Re-open the snackbar popover whenever
	// its contents change so it is ordered above that dialog and its Undo remains clickable.
	$effect(() => {
		const count = snackbar.items.length;
		const revision = ++popoverRevision;
		if (!host) return;
		if (host.matches(":popover-open")) host.hidePopover();
		const openDialog = document.querySelector<HTMLDialogElement>("dialog[open]");
		const container = openDialog ?? document.body;
		if (host.parentElement !== container) container.append(host);
		if (count > 0)
			queueMicrotask(() => {
				if (revision === popoverRevision && host && !host.matches(":popover-open"))
					host.showPopover();
			});
	});

	async function undo(
		id: number,
		u: { op: string; args: Record<string, unknown> },
		onUndo?: () => void | Promise<void>,
	) {
		snackbar.dismiss(id);
		try {
			if (onUndo) await onUndo();
			else await runOp(u.op, u.args);
			snackbar.push({ message: `${u.op} sent`, op: u.op, tone: "good" });
		} catch (error) {
			const reason = error instanceof Error && error.message ? ` · ${error.message}` : "";
			snackbar.push({
				message: `${u.op} failed${reason}`,
				op: u.op,
				tone: "danger",
				undo: u,
				onUndo,
				actionLabel: "Retry",
			});
		}
	}
</script>

<div bind:this={host} class="snack-stack" aria-live="polite" popover="manual">
	{#if hidden > 0}
		<div class="more">{hidden} more</div>
	{/if}
	{#each visible as s (s.id)}
		<div class="snack {s.tone}" role="status">
			<Icon name={s.tone === "danger" ? "triangle-alert" : "circle-check"} size={14} />
			<span>{s.message}</span>
			{#if s.undo}
				<button onclick={() => undo(s.id, s.undo!, s.onUndo)}>{s.actionLabel ?? "Undo"}</button>
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
		margin: 0;
		border: 0;
		padding: 0;
		background: transparent;
		overflow: visible;
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
