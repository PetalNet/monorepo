<script lang="ts">
	import { asset } from "$app/paths";

	import "../app.css";
	import type { Snippet } from "svelte";
	let { children }: { children: Snippet } = $props();
</script>

<svelte:head
	><link
		rel="preload"
		href={asset("fonts/geist-variable.woff2")}
		as="font"
		type="font/woff2"
		crossorigin="anonymous"
	/></svelte:head
>
{@render children()}
