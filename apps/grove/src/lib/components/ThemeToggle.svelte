<script lang="ts">
	import Moon from "@lucide/svelte/icons/moon";
	import Sun from "@lucide/svelte/icons/sun";

	import { Theme } from "#lib/theme.svelte.ts";

	const theme = new Theme();
</script>

<button
	class="btn btn-ghost btn-square"
	aria-label={theme.dark ? "Switch to light theme" : "Switch to dark theme"}
	onclick={() => {
		theme.toggle();
	}}
>
	{#if theme.dark}<Sun size={20} aria-hidden={true} />{:else}<Moon
			size={20}
			aria-hidden={true}
		/>{/if}
</button>
