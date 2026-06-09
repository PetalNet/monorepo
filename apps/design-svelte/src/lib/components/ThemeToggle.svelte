<script lang="ts">
	import Icon from "./Icon.svelte";
	import { theme } from "../theme.svelte";

	/**
	 * The Paper/Ink theme toggle. SSR renders Paper as pressed (matching the
	 * static light theme); once hydrated it reflects + drives the live theme.
	 * The aria-pressed values are derived from theme.current, which the head
	 * anti-FOUC script + theme.init() resolve before/at hydration.
	 */
</script>

<div class="toggle" role="group" aria-label="Theme">
	<button
		id="t-light"
		aria-pressed={theme.current === "light"}
		onclick={() => theme.apply("light")}>
		<span class="i" aria-hidden="true"><Icon name="sun" /></span>
		Paper
	</button>
	<button id="t-dark" aria-pressed={theme.current === "dark"} onclick={() => theme.apply("dark")}>
		<span class="i" aria-hidden="true"><Icon name="moon" /></span>
		Ink
	</button>
</div>
