<script lang="ts">
	import { ModeWatcher, mode, setTheme, theme, toggleMode } from "mode-watcher";
	import { tick } from "svelte";

	import favicon from "#lib/assets/favicon.svg";

	import "../app.css";

	let { children } = $props();

	$effect(() => {
		if (mode.current && theme.current !== mode.current) setTheme(mode.current);
	});

	function applyModeToggle() {
		toggleMode();
	}

	function toggleTheme() {
		if (
			window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
			!document.startViewTransition
		) {
			applyModeToggle();
			return;
		}

		document.startViewTransition(async () => {
			applyModeToggle();
			await tick();
		});
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<ModeWatcher
	defaultMode="system"
	disableTransitions
	disableHeadScriptInjection
	synchronousModeChanges
/>

<button
	type="button"
	class="btn btn-circle btn-ghost fixed top-4 right-4 z-50 text-xl"
	onclick={toggleTheme}
	aria-label="Toggle color scheme"
	title="Toggle color scheme"
>
	<span aria-hidden="true">◐</span>
</button>

{@render children()}
