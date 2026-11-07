<script lang="ts">
	import { dotsToMm } from "$lib/doc";

	import Dimension from "./Dimension.svelte";

	/** A stored printer raster on its strip, dimensioned from its own width in dots. */
	let { src, alt, height = 40 }: { src: string; alt: string; height?: number } = $props();

	let lengthDots = $state<number | null>(null);
</script>

<figure class="raster" style:--h="{height}px">
	<img
		{src}
		{alt}
		loading="lazy"
		onload={(event: Event) => {
			lengthDots = (event.currentTarget as HTMLImageElement).naturalWidth;
		}}
	/>
	{#if lengthDots !== null}<Dimension mm={dotsToMm(lengthDots)} size="sm" />{/if}
</figure>

<style>
	/* Sized to the drawn image so the dimension line spans the label, not the row. */
	.raster {
		display: grid;
		gap: 2px;
		width: fit-content;
		max-width: 100%;
		margin: 0;
	}

	img {
		max-width: 100%;
		max-height: var(--h);
		background: var(--tape);
		box-shadow: var(--tape-shadow);
		image-rendering: pixelated;
	}
</style>
