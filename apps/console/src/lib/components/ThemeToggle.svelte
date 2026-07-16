<script lang="ts">
	import { Moon, Sun } from "@lucide/svelte";
	import { PersistedState } from "runed";
	import { onMount } from "svelte";
	import { fade } from "svelte/transition";

	type Theme = "light" | "dark";

	// Seed from the theme the anti-FOUC head script already resolved (stored choice or OS
	// preference) so a first visit persists that, rather than overwriting it with a hardcoded default.
	const initialTheme: Theme =
		typeof document !== "undefined" && document.documentElement.dataset.theme === "dark"
			? "dark"
			: "light";

	// runed's localStorage-backed reactive state; cross-tab sync is on by default.
	const theme = new PersistedState<Theme>("theme", initialTheme);

	// The store reads localStorage synchronously, which can diverge from the SSR default; only
	// reflect the real value once mounted so hydration stays consistent.
	let mounted = $state(false);
	const displayed = $derived<Theme>(mounted ? theme.current : "light");

	onMount(() => {
		mounted = true;
	});

	$effect(() => {
		document.documentElement.dataset.theme = theme.current;
	});

	function toggle() {
		theme.current = theme.current === "dark" ? "light" : "dark";
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
