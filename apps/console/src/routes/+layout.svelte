<script lang="ts">
	import { goto } from "$app/navigation";
	import favicon from "$lib/assets/favicon.svg";
	import "@fontsource/geist-sans/400.css";
	import "@fontsource/geist-sans/500.css";
	import "@fontsource/geist-mono/400.css";
	import "@fontsource/geist-mono/500.css";
	import "../app.css";
	import AppShell from "$lib/components/AppShell.svelte";
	import { visibleNav } from "$lib/nav";

	let { data, children } = $props();

	// Deterministic quick-nav (foundations §3.6): `g` then a surface key jumps
	// surfaces, never routing through the assistant (no LLM in the emergency
	// path). `/` focuses the ask box (handled by the surface that owns the dock).
	let awaitingG = $state(false);
	let gTimer: ReturnType<typeof setTimeout> | undefined;

	function isTyping(t: EventTarget | null): boolean {
		const el = t as HTMLElement | null;
		return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
	}

	function onKey(e: KeyboardEvent) {
		if (isTyping(e.target)) return;
		if (awaitingG) {
			const entry = visibleNav(data.me.lanes).find((n) => n.key === e.key.toLowerCase());
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

<svelte:window onkeydown={onKey} />

<AppShell
	me={data.me}
	verdict={data.health.verdict}
	stateFact={data.health.stateFact}
	badges={data.health.badges}
>
	{@render children()}
</AppShell>
