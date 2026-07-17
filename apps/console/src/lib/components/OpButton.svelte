<script lang="ts">
	import { runOp } from "$lib/rpc/browser";
	import { canSeeOp, type OpDef } from "$lib/api/ops";
	import { snackbar } from "$lib/stores/snackbar.svelte";

	/**
	 * A named-op button (foundations §4.2, /task/683). Plain verb on the face; the
	 * op name lives in the hover audit note and the fired snackbar, never the
	 * label. Same op an agent calls, same effect, same audit line. Rules:
	 *   - visibility gates on the caller's lane (a viewer sees state, not controls)
	 *   - availability gates on the gating executor's liveness, NOT target freshness
	 *     (recovery stays hot; §2.3). Unreachable executor => disabled with reason.
	 *   - no op => no button (there is no UI-only action).
	 */
	interface Props {
		def: OpDef;
		args?: Record<string, unknown>;
		lanes: string[];
		/** Gating executor liveness (pre-flight per /executors). */
		executorLive?: boolean;
		/** Additional local availability fence, such as incomplete required input. */
		available?: boolean;
		unavailableNote?: string;
		/** Remote-Function execution seam. Defaults to the browser named-op client. */
		execute?: (args: Record<string, unknown>) => Promise<unknown>;
		variant?: "primary" | "tonal" | "ghost" | "danger";
		/** Display label override (e.g. "Restore" for a preset-arg variant of an op);
		 * the wire op + audit note stay `def.op`. Defaults to the catalog verb. */
		label?: string;
		/** Optional stale note surfaced in the soft-confirm ("state is 84s stale"). */
		staleNote?: string | null;
		onfired?: (op: string) => void;
	}
	let {
		def,
		args = {},
		lanes,
		executorLive = true,
		available = true,
		unavailableNote = "unavailable",
		execute,
		variant = "tonal",
		label,
		staleNote = null,
		onfired,
	}: Props = $props();

	let confirming = $state(false);
	let busy = $state(false);

	const visible = $derived(canSeeOp(def, lanes));
	const disabled = $derived(!executorLive || !available || busy);
	const auditNote = $derived(
		def.op +
			(!executorLive ? " · executor unreachable" : !available ? ` · ${unavailableNote}` : ""),
	);

	async function fire() {
		if (def.confirm !== "none" && !confirming) {
			confirming = true;
			return;
		}
		confirming = false;
		busy = true;
		try {
			const res = execute ? await execute(args) : await runOp(def.op, args);
			const undo =
				res && typeof res === "object" && "undo" in res
					? (res as { undo?: { op: string; args: Record<string, unknown> } }).undo
					: undefined;
			snackbar.push({
				message: `${def.op} sent`,
				op: def.op,
				tone: variant === "danger" ? "danger" : "good",
				undo: def.undo ? undo : undefined,
			});
			onfired?.(def.op);
		} catch (e) {
			snackbar.push({
				message: `${def.op} failed: ${(e as Error).message}`,
				op: def.op,
				tone: "danger",
			});
		} finally {
			busy = false;
		}
	}
</script>

{#if visible}
	<button
		class="op-btn {variant}"
		class:confirming
		{disabled}
		title={auditNote}
		onclick={fire}
		onblur={() => (confirming = false)}
	>
		{#if confirming}
			Confirm{staleNote ? ` (${staleNote})` : ""}
		{:else}
			{label ?? def.verb}
		{/if}
	</button>
{/if}

<style>
	.op-btn {
		font:
			500 0.8125rem var(--sans);
		border: 0;
		cursor: pointer;
		border-radius: var(--r-sm);
		padding: 0.5rem 1rem;
		min-height: 2rem;
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		background: var(--s2);
		color: var(--text);
		transition:
			background var(--t),
			transform var(--dur-fast) var(--ease-standard);
	}
	.op-btn:hover:not(:disabled) {
		background: var(--s3);
	}
	.op-btn:active:not(:disabled) {
		transform: scale(0.97);
	}
	.op-btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.primary {
		background: var(--petal-fill);
		color: var(--on-petal);
	}
	.primary:hover:not(:disabled) {
		background: color-mix(in srgb, var(--petal-fill) 88%, var(--text));
	}
	.tonal {
		background: var(--petal-soft);
		color: var(--petal-text);
	}
	.tonal:hover:not(:disabled) {
		background: color-mix(in srgb, var(--petal) 20%, transparent);
	}
	.danger {
		background: var(--danger-fill);
		color: var(--on-danger);
	}
	.confirming {
		background: var(--warn-soft);
		color: var(--warn-text);
	}
</style>
