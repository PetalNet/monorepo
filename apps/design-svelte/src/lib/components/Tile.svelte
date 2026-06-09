<script lang="ts">
	import type { Tile } from "../data";

	/** A launcher tile: status dot, accent icon, name, and a one-line tag. */
	let { tile }: { tile: Tile } = $props();
</script>

<!-- The tile is a tappable launcher target; tabindex matches the source spec. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="tile" tabindex="0">
	{#if tile.warn}
		<span class="tile-status status-warn"></span>
	{:else}
		<span class="tile-status"></span>
	{/if}
	<div class="tile-icon">
		<img src={tile.iconSvg} alt="" width="22" height="22" />
	</div>
	<div class="tile-name">{tile.name}</div>
	<div class="tile-tag">{tile.tag}</div>
</div>
