<script lang="ts">
	import type { Swatch } from "../data";

	/**
	 * One color swatch: a chip plus its token name and hex/role caption. The chip
	 * colour comes from the static chip-bg-* class (SSR light markup) or, after a
	 * theme-change rebuild, from an inline rawBg (the live computed value) —
	 * mirroring the source page's renderSwatches().
	 */
	let { swatch }: { swatch: Swatch } = $props();
</script>

<div class="swatch{swatch.ring ? ' ring' : ''}">
	{#if swatch.rawBg}
		<div class="chip" style="background:{swatch.rawBg}"></div>
	{:else}
		<div class="chip {swatch.cls}"></div>
	{/if}
	<div class="meta">
		<div class="name mono">{swatch.name}</div>
		<div class="hex">{swatch.hex}</div>
	</div>
</div>
