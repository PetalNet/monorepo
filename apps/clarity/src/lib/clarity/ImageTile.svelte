<!--
	One image tile — the vanilla imageTileHTML() as a component. Intrinsic
	width/height from the result's resolution (no reflow), lazy + no-referrer,
	hover overlay, and the inline onerror-hide becomes real state. data-i feeds
	the page's delegated lightbox open.
-->
<script lang="ts">
	import { safeHref } from "./claire-protocol";
	import { aspectOf, host, type Result } from "./search-helpers";

	let { result, index, openNewTab }: { result: Result; index: number; openNewTab: boolean } =
		$props();

	const src = $derived(result.thumbnail || result.img_src || "");
	const w = 300;
	const h = $derived(Math.max(1, Math.round(w / (aspectOf(result) || 1))));
	let failed = $state(false);
</script>

{#if !failed}
	<a
		class="img-tile"
		href={safeHref(result.url) ?? undefined}
		target={openNewTab ? "_blank" : undefined}
		rel={openNewTab ? "noopener" : undefined}
		data-i={index}
	>
		<img
			{src}
			loading="lazy"
			referrerpolicy="no-referrer"
			width={w}
			height={h}
			alt={(result.title || "").slice(0, 80)}
			onerror={() => (failed = true)}
		/>
		<span class="img-ov"
			><span class="img-ttl">{(result.title || "").slice(0, 90)}</span><span class="img-src mono"
				>{host(result.url)}</span
			></span
		>
	</a>
{/if}
