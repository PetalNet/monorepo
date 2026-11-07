<script lang="ts">
	import type { Snippet } from "svelte";
	import type { HTMLButtonAttributes } from "svelte/elements";

	type Props = HTMLButtonAttributes & {
		label: string;
		pressed?: boolean;
		children: Snippet;
	};

	let { label, pressed, children, ...rest }: Props = $props();
</script>

<button class="icon-button" aria-label={label} title={label} aria-pressed={pressed} {...rest}>
	{@render children()}
</button>

<style>
	.icon-button {
		position: relative;
		display: inline-grid;
		place-items: center;
		width: 32px;
		height: 32px;
		border: 0;
		border-radius: var(--r);
		background: transparent;
		color: var(--ink-2);
		cursor: pointer;
		transition:
			background-color var(--fast) var(--ease-standard),
			color var(--fast) var(--ease-standard);
	}

	/* A thumb-sized hit area without growing the visual. */
	.icon-button::after {
		content: "";
		position: absolute;
		inset: -6px;
	}

	.icon-button:hover:not(:disabled) {
		background: var(--hover);
		color: var(--ink);
	}

	.icon-button:active:not(:disabled) {
		background: var(--press);
	}

	.icon-button[aria-pressed="true"] {
		background: var(--accent-soft);
		color: var(--accent-text);
	}

	.icon-button:disabled {
		opacity: 0.35;
		cursor: default;
	}

	.icon-button :global(svg) {
		width: 18px;
		height: 18px;
		stroke-width: 1.75;
	}
</style>
