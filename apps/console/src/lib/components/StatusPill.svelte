<script lang="ts">
	import type { Tone } from "$lib/api/derive";
	import StatusDot from "./StatusDot.svelte";

	/**
	 * StatusPill (foundations §3.7): dot + text-grade label; pulse only when
	 * streaming. `hollow` renders the derived-offline (gone-quiet) look.
	 */
	interface Props {
		tone?: Tone;
		label: string;
		pulse?: boolean;
		hollow?: boolean;
	}
	let { tone = "idle", label, pulse = false, hollow = false }: Props = $props();
</script>

<span class="pill {tone}" class:hollow>
	<StatusDot {tone} {pulse} />
	{label}
</span>

<style>
	.pill {
		display: inline-flex;
		align-items: center;
		gap: var(--s-1);
		border-radius: var(--r-pill);
		padding: 2px var(--s-2);
		font:
			500 0.75rem var(--sans);
		min-height: 24px;
		background: var(--s2);
		color: var(--text-2);
	}
	.good {
		background: var(--good-soft);
		color: var(--good-text);
	}
	.warn {
		background: var(--warn-soft);
		color: var(--warn-text);
	}
	.danger {
		background: var(--danger-soft);
		color: var(--danger-text);
	}
	.info {
		background: var(--info-soft);
		color: var(--info-text);
	}
	.hollow {
		background: transparent;
		box-shadow: inset 0 0 0 1px var(--rule-strong);
		color: var(--text-3);
	}
</style>
