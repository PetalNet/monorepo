<script lang="ts">
	import { X } from "@lucide/svelte";
	import type { Snippet } from "svelte";

	import IconButton from "./IconButton.svelte";

	let {
		open = $bindable(false),
		title,
		width = "480px",
		children,
		footer,
		onclose,
	}: {
		open?: boolean;
		title: string;
		width?: string;
		children: Snippet;
		footer?: Snippet;
		onclose?: () => void;
	} = $props();

	let dialog = $state<HTMLDialogElement>();

	$effect(() => {
		if (!dialog) {
			return;
		}

		if (open && !dialog.open) {
			dialog.showModal();
		} else if (!open && dialog.open) {
			dialog.close();
		}
	});
</script>

<dialog
	bind:this={dialog}
	class="sheet"
	style:--width={width}
	aria-label={title}
	onclose={() => {
		open = false;
		onclose?.();
	}}
	onclick={(event) => {
		if (event.target === dialog) {
			open = false;
		}
	}}
>
	<div class="frame">
		<header>
			<h2>{title}</h2>
			<IconButton
				label="Close"
				onclick={() => {
					open = false;
				}}><X /></IconButton
			>
		</header>
		<div class="content">{@render children()}</div>
		{#if footer}<footer>{@render footer()}</footer>{/if}
	</div>
</dialog>

<style>
	.sheet {
		width: min(var(--width), calc(100vw - 32px));
		max-width: none;
		max-height: min(86dvh, 820px);
		margin: auto;
		padding: 0;
		border: 0;
		border-radius: var(--r-sheet);
		background: var(--sheet);
		color: var(--ink);
		box-shadow: var(--shadow-sheet);
		overflow: hidden;
	}

	.sheet[open] {
		animation: rise var(--slow) var(--ease);
	}

	.sheet::backdrop {
		background: var(--scrim);
		animation: fade var(--base) var(--ease-standard);
	}

	.frame {
		display: flex;
		flex-direction: column;
		max-height: inherit;
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 12px 12px 8px 20px;
	}

	h2 {
		font-size: 16px;
		font-weight: 600;
	}

	.content {
		flex: 1;
		min-height: 0;
		padding: 8px 20px 20px;
		overflow: auto;
		overscroll-behavior: contain;
	}

	footer {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		padding: 12px 20px calc(12px + env(safe-area-inset-bottom));
		box-shadow: 0 -1px 0 var(--rule);
	}

	@media (max-width: 640px) {
		.sheet {
			width: 100vw;
			max-height: 92dvh;
			margin: auto 0 0;
			border-end-start-radius: 0;
			border-end-end-radius: 0;
		}

		.sheet[open] {
			animation: slide var(--slow) var(--ease);
		}

		header::before {
			content: "";
			position: absolute;
			top: 6px;
			left: 50%;
			width: 36px;
			height: 4px;
			border-radius: 2px;
			background: var(--rule-strong);
			transform: translateX(-50%);
		}

		footer :global(.button) {
			flex: 1;
		}
	}

	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(8px) scale(0.985);
		}
	}

	@keyframes slide {
		from {
			transform: translateY(100%);
		}
	}

	@keyframes fade {
		from {
			opacity: 0;
		}
	}
</style>
