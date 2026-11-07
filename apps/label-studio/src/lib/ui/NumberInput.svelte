<script lang="ts">
	let {
		value,
		onchange,
		min,
		max,
		step = 1,
		unit,
		id,
		label,
		disabled = false,
	}: {
		value: number;
		onchange: (value: number) => void;
		min?: number;
		max?: number;
		step?: number;
		unit?: string;
		id?: string;
		label?: string;
		disabled?: boolean;
	} = $props();

	function clamp(next: number): number {
		let result = next;

		if (min !== undefined) {
			result = Math.max(min, result);
		}

		if (max !== undefined) {
			result = Math.min(max, result);
		}

		return result;
	}

	function input(event: Event): void {
		const next = (event.currentTarget as HTMLInputElement).valueAsNumber;

		if (Number.isFinite(next)) {
			onchange(clamp(next));
		}
	}
</script>

<span class="number" class:disabled>
	<input
		{id}
		type="number"
		inputmode="decimal"
		class="num"
		aria-label={label}
		{value}
		{min}
		{max}
		{step}
		{disabled}
		oninput={input}
	/>
	{#if unit}<span class="unit">{unit}</span>{/if}
</span>

<style>
	.number {
		display: inline-flex;
		align-items: center;
		flex: 1;
		min-width: 0;
		height: 32px;
		padding-inline: 8px;
		border-radius: var(--r);
		background: var(--sunken);
		transition: background-color var(--fast);
	}

	.number:hover {
		background: color-mix(in oklch, var(--sunken), var(--ink) 5%);
	}

	.number:focus-within {
		outline: 2px solid var(--accent);
		outline-offset: 0;
	}

	.disabled {
		opacity: 0.5;
	}

	input {
		flex: 1;
		min-width: 0;
		border: 0;
		background: transparent;
		outline: none;
		appearance: textfield;
	}

	input::-webkit-inner-spin-button,
	input::-webkit-outer-spin-button {
		appearance: none;
	}

	.unit {
		color: var(--ink-3);
		font-size: 12px;
	}

	@media (pointer: coarse) {
		.number {
			height: 40px;
		}
	}
</style>
