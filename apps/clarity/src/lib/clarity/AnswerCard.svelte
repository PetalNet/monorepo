<!--
	The instant-answer / calculator card above web results — the vanilla
	answerHTML() priority chain as a component:
	1. safe client-side calc result
	2. resolved Numbat card (numbatCard() — Numbat's own highlighted HTML, the one
	   legitimate {@html} here: it renders Numbat WASM output, never user markup)
	3. the reserved "calculating · Numbat" shell (same geometry → zero layout shift)
	4. SearXNG answers[] lines
-->
<script lang="ts">
	import { calcAnswer, looksCalc, numbatCard, parseRecency, type Entry } from "./search-helpers";

	let { entry }: { entry: Entry } = $props();

	const cq = $derived(parseRecency(entry.q).q);
	const calc = $derived(entry.cat === "general" ? calcAnswer(cq) : null);
	const pendingNumbat = $derived(
		entry.cat === "general" && entry.numbat === undefined && looksCalc(cq),
	);
</script>

{#if calc !== null}
	<div class="r-answer calc">
		<div class="ans-expr mono">{cq.replace(/\s*=\s*$/, "")} =</div>
		<div class="ans-val">
			{Number(calc).toLocaleString(undefined, { maximumFractionDigits: 10 })}
		</div>
	</div>
{:else if entry.numbat}
	<!-- eslint-disable-next-line svelte/no-at-html-tags -- Numbat WASM's own formatted output -->
	{@html numbatCard(entry.numbat)}
{:else if pendingNumbat}
	<div class="r-answer calc numbat-card numbat-pending">
		<div class="nc-exp">{cq}</div>
		<div class="nc-resrow"><span class="nc-res">…</span></div>
		<div class="nc-meta">calculating · Numbat</div>
	</div>
{:else if entry.answers?.length}
	<div class="r-answer">
		{#each entry.answers as a, i (i)}
			<div class="ans-line">{a}</div>
		{/each}
	</div>
{/if}
