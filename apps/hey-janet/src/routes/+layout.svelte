<script lang="ts">
	import { preloads } from "fontless/runtime";
	import type { Snippet } from "svelte";

	import "../app.css";
	let { children }: { children: Snippet } = $props();
</script>

<svelte:head>
	{#each preloads as link (link.href)}
		<link {...link} />
	{/each}
</svelte:head>
{@render children()}
