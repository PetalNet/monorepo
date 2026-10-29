<script lang="ts">
	import Moon from "@lucide/svelte/icons/moon";
	import Sun from "@lucide/svelte/icons/sun";
	import { onMount } from "svelte";

	let dark = $state(false);

	const applyTheme = (theme: "light" | "dark") => {
		const root = document.documentElement;

		root.classList.add("no-theme-transition");
		root.setAttribute("data-theme", theme);
		localStorage.setItem("petalnet-theme", theme);
		dark = theme === "dark";

		requestAnimationFrame(() => {
			root.classList.remove("no-theme-transition");
		});
	};

	const toggle = () => {
		applyTheme(dark ? "light" : "dark");
	};

	// app.html sets the theme before first paint; the button reads it once it is in the browser.
	onMount(() => {
		dark = document.documentElement.getAttribute("data-theme") === "dark";
	});
</script>

<button
	class="theme-toggle"
	type="button"
	onclick={toggle}
	aria-label={dark ? "Use light theme" : "Use dark theme"}
	title={dark ? "Use light theme" : "Use dark theme"}
>
	{#if dark}<Sun size={17} strokeWidth={1.8} />{:else}<Moon size={17} strokeWidth={1.8} />{/if}
</button>
