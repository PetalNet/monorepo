<script lang="ts">
	import { Moon, Sun } from "@lucide/svelte";
	import { onMount } from "svelte";
	import { fade } from "svelte/transition";

	type Theme = "light" | "dark";

	let theme = $state<Theme>("light");

	onMount(() => {
		theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
	});

	function toggle() {
		theme = theme === "dark" ? "light" : "dark";
		document.documentElement.dataset.theme = theme;
		localStorage.setItem("theme", theme);
	}
</script>

<button
	type="button"
	class="btn btn-circle btn-ghost"
	aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
	onclick={toggle}
>
	{#key theme}
		<span class="grid place-items-center" in:fade={{ duration: 150 }}>
			{#if theme === "dark"}
				<Sun class="size-5" aria-hidden="true" />
			{:else}
				<Moon class="size-5" aria-hidden="true" />
			{/if}
		</span>
	{/key}
</button>
