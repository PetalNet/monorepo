<script lang="ts">
	/** A range with its live value beside it: every drag redraws the label. */
	let {
		label,
		value,
		min,
		max,
		step,
		format,
		onchange,
	}: {
		label: string;
		value: number;
		min: number;
		max: number;
		step: number;
		format: (value: number) => string;
		onchange: (value: number) => void;
	} = $props();

	const id = $props.id();
	const fill = $derived(max > min ? ((value - min) / (max - min)) * 100 : 0);
</script>

<div class="slider">
	<label for={id}>{label}</label>
	<input
		{id}
		type="range"
		{min}
		{max}
		{step}
		{value}
		style:--fill="{fill}%"
		oninput={(event) => {
			onchange(event.currentTarget.valueAsNumber);
		}}
	/>
	<output for={id} class="num">{format(value)}</output>
</div>

<style>
	.slider {
		display: grid;
		grid-template-columns: 88px minmax(0, 1fr) 64px;
		align-items: center;
		gap: 8px;
		min-height: 32px;
	}

	label {
		color: var(--ink-2);
		font-size: 13px;
	}

	output {
		color: var(--ink-2);
		font-size: 12px;
		text-align: end;
	}

	input {
		width: 100%;
		height: 20px;
		margin: 0;
		background: transparent;
		appearance: none;
		cursor: pointer;
	}

	input::-webkit-slider-runnable-track {
		height: 4px;
		border-radius: 2px;
		background: linear-gradient(to right, var(--ink-2) var(--fill), var(--rule-strong) var(--fill));
	}

	input::-moz-range-track {
		height: 4px;
		border-radius: 2px;
		background: linear-gradient(to right, var(--ink-2) var(--fill), var(--rule-strong) var(--fill));
	}

	input::-webkit-slider-thumb {
		width: 16px;
		height: 16px;
		margin-top: -6px;
		border-radius: 50%;
		background: var(--sheet);
		box-shadow:
			0 0 0 1px var(--rule-strong),
			0 1px 3px oklch(0 0 0 / 0.2);
		appearance: none;
		transition: transform var(--fast) var(--ease);
	}

	input::-moz-range-thumb {
		width: 16px;
		height: 16px;
		border: 0;
		border-radius: 50%;
		background: var(--sheet);
		box-shadow:
			0 0 0 1px var(--rule-strong),
			0 1px 3px oklch(0 0 0 / 0.2);
	}

	input:active::-webkit-slider-thumb {
		transform: scale(1.15);
	}

	input:focus-visible {
		outline: none;
	}

	input:focus-visible::-webkit-slider-thumb {
		box-shadow: 0 0 0 2px var(--accent);
	}

	input:focus-visible::-moz-range-thumb {
		box-shadow: 0 0 0 2px var(--accent);
	}

	@media (pointer: coarse) {
		.slider {
			min-height: 44px;
		}

		input::-webkit-slider-thumb {
			width: 22px;
			height: 22px;
			margin-top: -9px;
		}
	}
</style>
