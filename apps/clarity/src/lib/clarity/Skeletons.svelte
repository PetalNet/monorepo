<!--
	Per-mode loading skeletons — each matches the layout about to land (a text
	skeleton ≠ an image skeleton). Heights via CSS classes, no inline styles.
-->
<script lang="ts">
	let { cat }: { cat: string } = $props();

	const IMG_TILE_CLASSES = Array.from({ length: 16 }, (_, i) => `sk-h${i % 8}`);
</script>

{#if cat === "images"}
	<div class="img-grid">
		{#each IMG_TILE_CLASSES as c, i (i)}
			<div class="img-tile sk sk-fill {c}"></div>
		{/each}
	</div>
{:else if cat === "videos"}
	<div class="vid-grid">
		{#each { length: 8 }, i (i)}
			<div class="vid-card sk">
				<div class="vid-thumb sk-fill"></div>
				<div class="sk-bar sk-vtitle"></div>
				<div class="sk-bar sk-vtitle2"></div>
				<div class="sk-bar sk-vmeta"></div>
			</div>
		{/each}
	</div>
{:else}
	{#each { length: 6 }, i (i)}
		<div class="result-row sk">
			<div class="sk-bar sk-url"></div>
			<div class="sk-bar sk-title"></div>
			<div class="sk-bar"></div>
			<div class="sk-bar sk-snip2"></div>
		</div>
	{/each}
{/if}
