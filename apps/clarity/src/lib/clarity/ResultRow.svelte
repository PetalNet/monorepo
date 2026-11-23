<!--
	One web result row — the vanilla rowHTML() template as a real component:
	crumb (favicon + host + file-type badge + date), title link, snippet, and the
	per-engine "via" icons. The favicon's inline onerror-remove becomes state.
-->
<script lang="ts">
	import { safeHref } from "./claire-protocol";
	import EngineIcon from "./EngineIcon.svelte";
	import { fileBadge, host, type Result } from "./search-helpers";

	let { result, openNewTab }: { result: Result; openNewTab: boolean } = $props();

	const h = $derived(host(result.url));
	const engines = $derived(
		(result.engines?.length ? result.engines : [result.engine]).filter((e): e is string => !!e),
	);
	const badge = $derived(fileBadge(result.url));
	const date = $derived(result.publishedDate ? String(result.publishedDate).slice(0, 10) : "");
	let favFailed = $state(false);
</script>

<article class="result-row">
	<div class="r-crumb">
		<span class="r-fav">
			{#if !favFailed}
				<img
					src="https://favicons.petalcat.dev/favicon?url={encodeURIComponent(
						'https://' + h,
					)}&size=32"
					alt=""
					decoding="async"
					onerror={() => (favFailed = true)}
				/>
			{/if}
			{(h[0] || "?").toUpperCase()}
		</span>
		<span class="r-url">{h}</span>
		{#if badge}<span class="ft ft-{badge.fam}">{badge.ext}</span>{/if}
		{#if date}
			<span class="r-sep">›</span> <span class="r-date">{date}</span>
		{/if}
	</div>
	<a
		class="r-title"
		href={safeHref(result.url) ?? undefined}
		target={openNewTab ? "_blank" : undefined}
		rel={openNewTab ? "noopener" : undefined}>{result.title || result.url}</a
	>
	<div class="r-snippet">{(result.content || "").slice(0, 280)}</div>
	<div class="r-engines">
		<span class="r-via">via</span>
		{#each engines as en (en)}
			<EngineIcon engine={en} />
		{/each}
	</div>
</article>
