<!--
	One video result card — the vanilla videoCardHTML() as a component: 16:9
	thumb with play affordance + duration pill, two-line title, author/host meta.
-->
<script lang="ts">
	import { safeHref } from "./claire-protocol";
	import { host, type Result } from "./search-helpers";

	let { result, openNewTab }: { result: Result; openNewTab: boolean } = $props();

	const thumb = $derived(result.thumbnail || result.img_src || "");
	const dur = $derived(String(result.length || result.duration || "").trim());
	const ch = $derived(result.author || host(result.url));
	const date = $derived.by(() => {
		if (!result.publishedDate) {
			return "";
		}

		const d = new Date(result.publishedDate);

		return isNaN(+d)
			? ""
			: d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
	});
	let thumbFailed = $state(false);
</script>

<a
	class="vid-card"
	href={safeHref(result.url) ?? undefined}
	target={openNewTab ? "_blank" : undefined}
	rel={openNewTab ? "noopener" : undefined}
>
	<div class="vid-thumb">
		{#if thumb && !thumbFailed}
			<img
				src={thumb}
				loading="lazy"
				referrerpolicy="no-referrer"
				alt=""
				onerror={() => (thumbFailed = true)}
			/>
		{/if}
		<span class="vid-play"
			><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor" /></svg></span
		>
		{#if dur}<span class="vid-dur">{dur}</span>{/if}
	</div>
	<div class="vid-title">{result.title || result.url}</div>
	<div class="vid-meta mono">{ch}{date ? " · " + date : ""}</div>
</a>
