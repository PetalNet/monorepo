<!--
	One engine's favicon in the "via" row. The server resolves + caches any
	engine's favicon at /engines/<name>.png; on miss/load error this falls back
	to the colored dot — the vanilla inline onerror handler as real state.
-->
<script lang="ts">
	import { ENGINE_COLORS } from "./search-helpers";

	let { engine }: { engine: string } = $props();
	let failed = $state(false);
</script>

{#if failed}
	<i class="r-dot" title={engine} style:background={ENGINE_COLORS[engine] || "#8a8a8a"}></i>
{:else}
	<img
		class="r-eng-ic"
		src="/engines/{encodeURIComponent(engine)}.png"
		alt={engine}
		title={engine}
		decoding="async"
		onerror={() => (failed = true)}
	/>
{/if}
