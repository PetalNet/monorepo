<script lang="ts">
	import type { Component, Snippet } from "svelte";

	let {
		title,
		icon: Icon,
		status,
		children,
	}: { title: string; icon: Component; status?: Snippet; children: Snippet } = $props();
</script>

<section class="card">
	<header class="card-head">
		<div class="card-title">
			<span class="card-icon"><Icon size={18} strokeWidth={1.7} /></span>
			<h2>{title}</h2>
		</div>
		{#if status}
			{@render status()}
		{/if}
	</header>
	<div class="card-body">{@render children()}</div>
</section>
