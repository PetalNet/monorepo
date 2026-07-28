<script lang="ts">
	import Moon from "@lucide/svelte/icons/moon";
	import Sun from "@lucide/svelte/icons/sun";
	import { ModeWatcher, mode, toggleMode } from "mode-watcher";
	import { tick } from "svelte";

	import favicon from "#lib/assets/favicon.svg";

	import "../app.css";

	let { children } = $props();

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

<ModeWatcher synchronousModeChanges />

<label class="text-base-content fixed top-4 right-4 z-50 flex cursor-pointer items-center gap-2">
	<Sun aria-hidden={true} class="size-5" />
	<input
		type="checkbox"
		value="dark"
		class="toggle theme-controller"
		checked={mode.current === "dark"}
		onclick={(event) => {
			event.preventDefault();
			toggleTheme();
		}}
		aria-label="Toggle color scheme"
	/>
	<Moon aria-hidden={true} class="size-5" />
</label>

{@render children()}
