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

<label class="text-base-content fixed top-4 right-4 z-50 flex cursor-pointer items-center gap-2">
	<svg
		aria-hidden="true"
		class="size-5"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
	>
		<circle cx="12" cy="12" r="5"></circle>
		<path
			d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l-1.4 1.4"
		></path>
	</svg>
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
	<svg
		aria-hidden="true"
		class="size-5"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
	>
		<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
	</svg>
</label>

{@render children()}
