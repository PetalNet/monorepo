<script lang="ts">
	import "../app.css";
	import ThemeToggle from "$lib/components/ThemeToggle.svelte";

	import type { LayoutProps } from "./$types";

	let { children }: LayoutProps = $props();
</script>

<div class="fixed end-0 top-0 z-50 p-4">
	<ThemeToggle />
</div>

{@render children()}
