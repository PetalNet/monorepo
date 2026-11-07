<script lang="ts" generics="T extends string">
	import type { Snippet } from "svelte";

	interface Option {
		value: T;
		label: string;
		icon?: Snippet;
	}

	let {
		options,
		value,
		label,
		size = "md",
		onchange,
	}: {
		options: readonly Option[];
		value: T;
		label: string;
		size?: "sm" | "md";
		onchange: (value: T) => void;
	} = $props();

	const index = $derived(
		Math.max(
			0,
			options.findIndex((option) => option.value === value),
		),
	);

	function pick(next: T): void {
		onchange(next);
	}

	function keydown(event: KeyboardEvent): void {
		const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;

		if (step !== 0) {
			event.preventDefault();
			const next = options[(index + step + options.length) % options.length];

			pick(next.value);
			const group = event.currentTarget as HTMLElement;

			group.querySelectorAll<HTMLButtonElement>("button").item(options.indexOf(next)).focus();
		}
	}
</script>

<div
	class="segmented {size}"
	role="radiogroup"
	aria-label={label}
	tabindex="-1"
	style:--count={options.length}
	style:--index={index}
	onkeydown={keydown}
>
	<span class="thumb" aria-hidden="true"></span>
	{#each options as option (option.value)}
		<button
			type="button"
			role="radio"
			aria-checked={option.value === value}
			tabindex={option.value === value ? 0 : -1}
			onclick={() => {
				pick(option.value);
			}}
		>
			{#if option.icon}{@render option.icon()}{/if}
			<span>{option.label}</span>
		</button>
	{/each}
</div>

<style>
	.segmented {
		position: relative;
		display: grid;
		grid-template-columns: repeat(var(--count), 1fr);
		padding: 2px;
		border-radius: calc(var(--r) + 2px);
		background: var(--sunken);
		isolation: isolate;
	}

	.thumb {
		position: absolute;
		inset-block: 2px;
		inset-inline-start: 2px;
		width: calc((100% - 4px) / var(--count));
		border-radius: var(--r);
		background: var(--panel);
		box-shadow: var(--shadow-panel);
		transform: translateX(calc(100% * var(--index)));
		transition: transform var(--base) var(--ease);
		z-index: -1;
	}

	button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		height: 28px;
		padding-inline: 10px;
		border: 0;
		background: transparent;
		color: var(--ink-2);
		font-weight: 500;
		white-space: nowrap;
		cursor: pointer;
		transition: color var(--fast);
	}

	.sm button {
		height: 24px;
		font-size: 12px;
	}

	@media (pointer: coarse) {
		.md button {
			height: 36px;
		}
	}

	button[aria-checked="true"] {
		color: var(--ink);
	}

	button :global(svg) {
		width: 15px;
		height: 15px;
		stroke-width: 1.75;
	}
</style>
