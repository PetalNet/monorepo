<script lang="ts">
	import type { LayoutProps } from "./$types";
	import { goto } from "$app/navigation";
	import favicon from "$lib/assets/favicon.svg";
	import { ModeWatcher } from "mode-watcher";
	import "@fontsource/geist-sans/400.css";
	import "@fontsource/geist-sans/500.css";
	import "@fontsource/geist-mono/400.css";
	import "@fontsource/geist-mono/500.css";
	import "../app.css";
	import AppShell from "$lib/components/AppShell.svelte";
	import { visibleNav } from "$lib/nav";

	let { data, children }: LayoutProps = $props();

	// Deterministic quick-nav (foundations §3.6): `g` then a surface key jumps
	// surfaces, never routing through the assistant (no LLM in the emergency
	// path). The shell owns `/`, so its advertised behavior is route-independent.
	let awaitingG = $state(false);
	let gTimer: ReturnType<typeof setTimeout> | undefined;

	function isTyping(t: EventTarget | null): boolean {
		const el = t as HTMLElement | null;
		return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
	}

	async function focusAsk() {
		let ask = document.querySelector<HTMLInputElement>("input[data-global-ask]:not(:disabled)");
		if (!ask) {
			await goto("/");
			ask = document.querySelector<HTMLInputElement>("input[data-global-ask]:not(:disabled)");
		}
		ask?.focus();
	}

	function onKey(e: KeyboardEvent) {
		if (!data.authenticated) return;
		if (isTyping(e.target)) return;
		if (e.key === "/") {
			e.preventDefault();
			void focusAsk();
			return;
		}
		if (awaitingG) {
			const entry = data.authenticated
				? visibleNav(data.me.lanes).find((n) => n.key === e.key.toLowerCase())
				: undefined;
			awaitingG = false;
			clearTimeout(gTimer);
			if (entry) {
				e.preventDefault();
				void goto(entry.href);
			}
			return;
		}
		if (e.key === "g") {
			awaitingG = true;
			gTimer = setTimeout(() => (awaitingG = false), 1200);
		}
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<ModeWatcher defaultMode="system" defaultTheme="light" disableTransitions />

<svelte:window onkeydown={onKey} />

{#if data.authenticated}
	<AppShell
		me={data.me}
		verdict={data.health.verdict}
		stateFact={data.health.stateFact}
		badges={data.health.badges}
		connected={data.connected}
	>
		{@render children()}
	</AppShell>
{:else}
	{@render children()}
{/if}
