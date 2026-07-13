<script lang="ts">
	import type { Snippet } from "svelte";
	import { dataMode, sendAssistantContext, sendAssistantMessage, type AssistantContextPayload } from "$lib/api/client";
	import type { HealthVerdict } from "$lib/api/derive";
	import type { Me } from "$lib/api/types";
	import AskDock, { type ContextPayload } from "./AskDock.svelte";
	import Icon from "./Icon.svelte";
	import Sidebar from "./Sidebar.svelte";
	import Snackbar from "./Snackbar.svelte";

	/**
	 * The one fixed frame, three regions (foundations §2.1): sidebar 232px + canvas.
	 * Collapses to a 56px icon rail below 1280px; single-column canvas below 1024px.
	 * The shell owns the one durable assistant dock and universal selected-context seam.
	 */
	interface Props {
		me: Me;
		verdict: HealthVerdict;
		stateFact?: string | null;
		badges?: Record<string, number | "down" | "p0" | "warn" | "muted" | null>;
		connected?: boolean;
		children: Snippet;
	}
	let { me, verdict, stateFact = null, badges = {}, connected = true, children }: Props = $props();

	let askRef = $state<AskDock | null>(null);
	let context = $state<ContextPayload | null>(null);
	let progress = $state<string | null>(null);
	let transcript = $state<string | null>(null);
	let assistantFailed = $state(false);
	let contextDelivery: Promise<void> | null = null;
	let menu = $state<{ x: number; y: number; target: HTMLElement } | null>(null);
	let menuEl = $state<HTMLDivElement | null>(null);
	const assistantDown = $derived(!connected || dataMode() !== "live" || assistantFailed);

	function payloadFor(target: HTMLElement): AssistantContextPayload {
		const contributor = target.closest<HTMLElement>("[data-ask], [data-query-ref], [data-entity-ref]") ?? target;
		const raw = contributor.dataset.ask ?? contributor.getAttribute("aria-label") ?? contributor.textContent ?? contributor.tagName;
		const value = raw.replace(/\s+/g, " ").trim().slice(0, 500) || contributor.tagName.toLowerCase();
		return {
			element_kind: contributor.dataset.askKind ?? contributor.getAttribute("role") ?? contributor.tagName.toLowerCase(),
			value,
			...(contributor.dataset.askField ? { field: contributor.dataset.askField } : {}),
			...(contributor.dataset.queryRef ? { query_ref: contributor.dataset.queryRef } : {}),
			...(contributor.dataset.entityRef ? { entity_ref: contributor.dataset.entityRef } : {}),
		};
	}

	function openContextMenu(event: MouseEvent) {
		if (window.getSelection()?.toString()) return;
		const target = event.target instanceof HTMLElement ? event.target : null;
		if (!target || target.closest("input, textarea, [contenteditable=true]")) return;
		event.preventDefault();
		menu = { x: Math.min(event.clientX, window.innerWidth - 176), y: Math.min(event.clientY, window.innerHeight - 104), target };
		queueMicrotask(() => menuEl?.querySelector<HTMLButtonElement>("button")?.focus());
	}

	function openKeyboardMenu(event: KeyboardEvent) {
		const target = event.target instanceof HTMLElement ? event.target : null;
		const typing = !!target && (target.matches("input, textarea, [contenteditable=true]") || !!target.closest("input, textarea, [contenteditable=true]"));
		if (event.key === "/" && !typing) {
			event.preventDefault();
			askRef?.focus();
			return;
		}
		if (event.key === "Escape") {
			menu = null;
			return;
		}
		if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
		if (!target) return;
		event.preventDefault();
		const box = target.getBoundingClientRect();
		menu = { x: Math.min(box.left, window.innerWidth - 176), y: Math.min(box.bottom, window.innerHeight - 104), target };
		queueMicrotask(() => menuEl?.querySelector<HTMLButtonElement>("button")?.focus());
	}

	async function askAbout(target: HTMLElement) {
		const payload = payloadFor(target);
		context = { label: payload.value.slice(0, 64) };
		menu = null;
		queueMicrotask(() => askRef?.focus());
		if (assistantDown) return;
		contextDelivery = (async () => {
		try {
			await sendAssistantContext(payload);
		} catch {
			assistantFailed = true;
		}
		})();
		await contextDelivery;
		contextDelivery = null;
	}

	async function copyValue(target: HTMLElement) {
		try {
			await navigator.clipboard.writeText(payloadFor(target).value);
		} catch {
			/* Clipboard permission failure leaves the value unchanged and the menu closes. */
		}
		menu = null;
	}

	async function onAsk(question: string) {
		progress = "Janet is working.";
		try {
			await contextDelivery;
			if (assistantFailed) return;
			const reply = await sendAssistantMessage(question);
			transcript = reply.content;
			assistantFailed = false;
		} catch {
			assistantFailed = true;
			transcript = null;
		} finally {
			progress = null;
		}
	}

	function clearContext() {
		context = null;
	}
</script>

<svelte:window onkeydown={openKeyboardMenu} onclick={() => (menu = null)} />

<div class="shell">
	<Sidebar {me} {verdict} {stateFact} {badges} />
	<main class="canvas" oncontextmenu={openContextMenu}>
		<div class="surface">{@render children()}</div>
		<AskDock bind:this={askRef} mode="docked" {context} {progress} {transcript} {assistantDown} onask={onAsk} onclearcontext={clearContext} />
	</main>
</div>
{#if menu}
	<div bind:this={menuEl} class="context-menu" style:left={`${menu.x}px`} style:top={`${menu.y}px`} role="menu" aria-label="Element actions" tabindex="-1">
		<button type="button" role="menuitem" onclick={() => askAbout(menu!.target)}><Icon name="sparkles" size={16} />Ask about this</button>
		<button type="button" role="menuitem" onclick={() => copyValue(menu!.target)}>Copy value</button>
	</div>
{/if}
<Snackbar />

<style>
	.shell {
		display: grid;
		grid-template-columns: 232px 1fr;
		min-height: 100dvh;
		background: var(--bg);
	}
	.canvas {
		padding: var(--s-4) var(--s-4) var(--s-5);
		position: relative;
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.surface { min-width: 0; padding-bottom: 56px; }
	/* Transitional containment: older surfaces still render local docks. Shell ownership wins. */
	.surface :global(.ask-dockwrap), .surface :global(.ask-centered) { display: none; }
	.context-menu {
		position: fixed;
		z-index: var(--z-dropdown);
		width: 168px;
		padding: var(--s-1);
		background: var(--s1);
		box-shadow: 0 2px 8px color-mix(in srgb, var(--text) 14%, transparent);
		border-radius: var(--r-sm);
	}
	.context-menu button {
		width: 100%; min-height: 40px; padding: 0 var(--s-2); border: 0;
		background: transparent; color: var(--text); border-radius: var(--r-sm);
		display: flex; align-items: center; gap: var(--s-2); font: 500 .75rem var(--sans); text-align: left;
	}
	.context-menu button:hover { background: var(--s2); }
	.context-menu button:focus-visible { outline: 2px solid var(--petal); outline-offset: 2px; }
	@media (max-width: 1279px) {
		.shell {
			grid-template-columns: 56px 1fr;
		}
	}
	@media (max-width: 767px) {
		.canvas {
			padding: var(--s-3) var(--s-3) var(--s-5);
		}
	}
</style>
