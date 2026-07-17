<script lang="ts">
	import type { ApplyMode } from "$lib/data/updates";

	/**
	 * ApplyModeChip (09-updates §3.3): a READ-ONLY chip, deliberately not a control.
	 * Apply mode is agent-malleable (/task/711) — you ask Janet to change it, there
	 * is no settings maze. Focusable for the tooltip only.
	 */
	interface Props {
		mode: ApplyMode | null;
		onask?: () => void;
	}
	let { mode, onask }: Props = $props();
	const label = $derived(
		mode === "auto"
			? "Auto"
			: mode === "staged-approval"
				? "Staged approval"
				: mode === "manual-notify-only"
					? "Notify only"
					: "—",
	);
	function ask(event: MouseEvent) {
		event.stopPropagation();
		onask?.();
	}
	function keepKey(event: KeyboardEvent) {
		event.stopPropagation();
	}
</script>

<button
	type="button"
	class="chip"
	title="Apply mode is agent-malleable. Ask Janet to change it."
	onclick={ask}
	onkeydown={keepKey}
	aria-label="{label}. Ask Janet to change apply mode"
>
	{label}
</button>

<style>
	.chip {
		display: inline-flex;
		align-items: center;
		min-height: 32px;
		padding: 0 var(--s-2);
		border-radius: var(--r-xs);
		background: var(--s2);
		color: var(--text-2);
		font:
			500 0.6875rem var(--mono);
		white-space: nowrap;
		border: 0;
		cursor: pointer;
		transition: background var(--t);
	}
	.chip:hover {
		background: var(--s3);
	}
</style>
