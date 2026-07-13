<script lang="ts">
	import type { ApplyMode } from "$lib/data/updates";

	/**
	 * ApplyModeChip (09-updates §3.3): a READ-ONLY chip, deliberately not a control.
	 * Apply mode is agent-malleable (/task/711) — you ask Janet to change it, there
	 * is no settings maze. Focusable for the tooltip only.
	 */
	interface Props {
		mode: ApplyMode | null;
	}
	let { mode }: Props = $props();
	const label = $derived(
		mode === "auto"
			? "Auto"
			: mode === "staged-approval"
				? "Staged approval"
				: mode === "manual-notify-only"
					? "Notify only"
					: "—",
	);
</script>

<span class="chip" title="Apply mode is agent-malleable. Ask Janet to change it.">
	{label}
</span>

<style>
	.chip {
		display: inline-flex;
		align-items: center;
		height: 24px;
		padding: 0 var(--s-2);
		border-radius: var(--r-xs);
		background: var(--s2);
		color: var(--text-2);
		font:
			500 0.6875rem var(--mono);
		white-space: nowrap;
	}
</style>
