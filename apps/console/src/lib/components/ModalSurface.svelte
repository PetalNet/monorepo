<script lang="ts">
	import type { Snippet } from "svelte";

	interface Props {
		open: boolean;
		variant: "dialog" | "drawer" | "palette";
		labelledby: string;
		children: Snippet;
		onclose?: () => void;
		element?: HTMLDialogElement | null;
	}

	let { open, variant, labelledby, children, onclose, element = $bindable(null) }: Props = $props();
	let focusOrigin: HTMLElement | null = null;

	$effect(() => {
		if (!element) return;
		if (open && !element.open) {
			focusOrigin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			element.showModal();
		} else if (!open && element.open) {
			element.close();
		}
	});

	function handleClose() {
		onclose?.();
		const origin = focusOrigin;
		focusOrigin = null;
		queueMicrotask(() => origin?.focus());
	}

	function dismissBackdrop(event: MouseEvent) {
		if (event.target !== element || !element) return;
		const bounds = element.getBoundingClientRect();
		const outside = event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
		if (outside) element.close();
	}
</script>

<dialog bind:this={element} class="modal-surface {variant}" aria-labelledby={labelledby} onclose={handleClose} onclick={dismissBackdrop}>
	{@render children()}
</dialog>

<style>
	.modal-surface{position:fixed;z-index:var(--z-dialog);border:0;color:var(--text);padding:var(--s-4);box-shadow:var(--shadow-pop);overflow:auto}
	.modal-surface::backdrop{background:color-mix(in srgb,var(--text) 24%,transparent)}
	.modal-surface :global(.dialog-close){position:absolute;right:var(--s-3);top:var(--s-3)}
	.dialog{width:480px;max-width:calc(100% - var(--s-5));max-height:calc(100dvh - var(--s-5));margin:auto;background:var(--s2);border-radius:var(--r-lg)}
	.palette{width:640px;max-width:calc(100% - var(--s-5));max-height:min(680px,calc(100dvh - var(--s-5)));margin:10dvh auto auto;padding:0;background:var(--s1);border-radius:var(--r-lg);overflow:hidden}
	.drawer{inset:0 0 0 auto;width:420px;max-width:calc(100% - var(--s-4));height:100dvh;max-height:none;margin:0;background:var(--s1);border-radius:var(--r-lg) 0 0 var(--r-lg)}
	@media(max-width:767px){.drawer{width:100%;max-width:100%;border-radius:0}.palette{inset:0;width:100%;max-width:100%;max-height:100dvh;height:100dvh;margin:0;border-radius:0}}
</style>
