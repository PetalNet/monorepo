<script lang="ts">
	import { onMount } from "svelte";

	import "$lib/styles.css";
	import { theme } from "$lib/theme.svelte";

	let { children } = $props();

	// Re-apply the resolved theme on hydration (the head anti-FOUC script already
	// painted it; this syncs reactive state so the toggle buttons reflect it).
	onMount(() => theme.init());
</script>

{@render children()}
