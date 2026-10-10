<script lang="ts">
	import type { Snippet } from "svelte";
	let { title, children }: { title: string; children: Snippet } = $props();
</script>

<details class="collapse-arrow bg-base-200 collapse">
	<summary class="collapse-title text-base font-medium">{title}</summary>
	<div class="collapse-content">{@render children()}</div>
</details>
