<script lang="ts">
	import { ModeWatcher, mode, setTheme, toggleMode } from "mode-watcher";
	import { tick } from "svelte";

	import favicon from "#lib/assets/favicon.svg";

	import "../app.css";

	let { children } = $props();

	function applyModeToggle() {
		const nextMode = mode.current === "dark" ? "light" : "dark";
		toggleMode();
		setTheme(nextMode);
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

<ModeWatcher defaultMode="system" disableTransitions />

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
