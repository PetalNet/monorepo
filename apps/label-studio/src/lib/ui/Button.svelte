<script lang="ts">
	import type { Snippet } from "svelte";
	import type { HTMLButtonAttributes } from "svelte/elements";

	type Props = HTMLButtonAttributes & {
		variant?: "primary" | "secondary" | "ghost" | "danger";
		size?: "sm" | "md" | "lg";
		busy?: boolean;
		children: Snippet;
	};

	let {
		variant = "secondary",
		size = "md",
		busy = false,
		children,
		disabled,
		...rest
	}: Props = $props();
</script>

<button
	class="button {variant} {size}"
	disabled={(disabled ?? false) || busy}
	aria-busy={busy}
	{...rest}
>
	{#if busy}<span class="spinner" aria-hidden="true"></span>{/if}
	{@render children()}
</button>

<style>
	.button {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		height: 32px;
		padding-inline: 12px;
		border: 0;
		border-radius: var(--r);
		font-weight: 500;
		white-space: nowrap;
		cursor: pointer;
		transition:
			background-color var(--fast) var(--ease-standard),
			color var(--fast) var(--ease-standard),
			transform var(--fast) var(--ease-standard),
			opacity var(--fast);
	}

	.button:active:not(:disabled) {
		transform: scale(0.97);
	}

	.button:disabled {
		cursor: default;
		opacity: 0.45;
	}

	.sm {
		height: 28px;
		padding-inline: 10px;
		font-size: 13px;
	}

	.lg {
		height: 40px;
		padding-inline: 16px;
		font-size: 15px;
	}

	@media (pointer: coarse) {
		.md,
		.lg {
			height: 44px;
		}
	}

	.primary {
		background: var(--accent);
		color: var(--on-accent);
	}

	.primary:hover:not(:disabled) {
		background: var(--accent-hover);
	}

	.secondary {
		background: var(--sunken);
		color: var(--ink);
	}

	.secondary:hover:not(:disabled) {
		background: color-mix(in oklch, var(--sunken), var(--ink) 7%);
	}

	.ghost {
		background: transparent;
		color: var(--ink-2);
	}

	.ghost:hover:not(:disabled) {
		background: var(--hover);
		color: var(--ink);
	}

	.danger {
		background: var(--danger-soft);
		color: var(--danger);
	}

	.danger:hover:not(:disabled) {
		background: color-mix(in oklch, var(--danger-soft), var(--danger) 10%);
	}

	.spinner {
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: conic-gradient(currentColor 0 25%, transparent 25% 100%);
		mask: radial-gradient(circle, transparent 3.5px, #000 4px);
		animation: spin 700ms linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(1turn);
		}
	}
</style>
