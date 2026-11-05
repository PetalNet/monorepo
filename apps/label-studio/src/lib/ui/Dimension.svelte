<script lang="ts">
	import { cubicOut } from "svelte/easing";
	import { Tween } from "svelte/motion";

	import { formatMm } from "./words";

	/**
	 * A drafting dimension line: extension ticks at both ends, the measured span between them, the
	 * value in mm at its centre. Horizontal sits under the tape, vertical beside it.
	 */
	let {
		mm,
		axis = "x",
		label,
		size = "md",
	}: { mm: number; axis?: "x" | "y"; label?: string; size?: "sm" | "md" } = $props();

	const shown = new Tween(0, { duration: 260, easing: cubicOut });
	$effect(() => {
		void shown.set(mm);
	});
</script>

<div class="dimension {axis} {size}" role="img" aria-label={label ?? `${formatMm(mm)} millimetres`}>
	<span class="line" aria-hidden="true"></span>
	<span class="value num" aria-hidden="true">{formatMm(shown.current)}<small>&nbsp;mm</small></span>
</div>

<style>
	.dimension {
		position: relative;
		display: grid;
		place-items: center;
		color: var(--dimension);
		font-size: 12px;
	}

	.x {
		height: 20px;
		width: 100%;
	}

	.y {
		width: 20px;
		height: 100%;
	}

	.line {
		position: absolute;
		background: currentColor;
	}

	.x .line {
		inset-inline: 0;
		top: 50%;
		height: 1px;
	}

	.y .line {
		inset-block: 0;
		left: 50%;
		width: 1px;
	}

	.line::before,
	.line::after {
		content: "";
		position: absolute;
		background: currentColor;
	}

	.x .line::before,
	.x .line::after {
		top: -5px;
		width: 1px;
		height: 11px;
	}

	.x .line::before {
		left: 0;
	}

	.x .line::after {
		right: 0;
	}

	.y .line::before,
	.y .line::after {
		left: -5px;
		width: 11px;
		height: 1px;
	}

	.y .line::before {
		top: 0;
	}

	.y .line::after {
		bottom: 0;
	}

	.value {
		position: relative;
		padding-inline: 6px;
		background: var(--dimension-bg, var(--ground));
		color: var(--ink-2);
		line-height: 1;
		white-space: nowrap;
	}

	.value small {
		color: var(--ink-3);
		font-size: inherit;
	}

	.y .value {
		writing-mode: vertical-rl;
		transform: rotate(180deg);
		padding-block: 6px;
		padding-inline: 0;
	}

	.sm {
		font-size: 11px;
	}

	.sm.x {
		height: 16px;
	}
</style>
