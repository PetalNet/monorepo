<script lang="ts">
	import { Moon, Sun } from "@lucide/svelte";
	import { mode, setMode, setTheme } from "mode-watcher";
	import { fade } from "svelte/transition";

	const displayed = $derived(mode.current ?? "light");

	$effect(() => {
		// DaisyUI selects its two named themes through data-theme. mode-watcher owns the persisted
		// preference, system-mode resolution, SSR bootstrap, and transition suppression.
		setTheme(displayed);
	});

	function toggle() {
		setMode(displayed === "dark" ? "light" : "dark");
	}
</script>

<button
	type="button"
	class="btn btn-circle btn-ghost"
	aria-label={displayed === "dark" ? "Switch to light theme" : "Switch to dark theme"}
	onclick={toggle}
>
	{#key displayed}
		<span class="grid place-items-center" in:fade={{ duration: 150 }}>
			{#if displayed === "dark"}
				<Sun class="size-5" aria-hidden="true" />
			{:else}
				<Moon class="size-5" aria-hidden="true" />
			{/if}
		</span>
	{/key}
</button>
