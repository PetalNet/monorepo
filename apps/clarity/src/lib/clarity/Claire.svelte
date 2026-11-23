<!--
	Claire — the AI answer card above the web results. Renders the claire store's
	state machine (claire.svelte.ts drives it; backend untouched). Sentences are
	plain TEXT nodes (Svelte escapes them — the vanilla escC() comes free) and every
	backend URL passes safeHref() before it may become an href (a javascript: URL
	renders as a <span>, never a link). On the private/local route the source chips
	show a shield instead of fetching off-box favicons.
-->
<script lang="ts">
	import { safeHref, type ClaireSentence, type ClaireSource } from "./claire-protocol";
	import { claire } from "./claire.svelte";

	const tgt = $derived(claire.newTab ? "_blank" : undefined);
	const rel = $derived(claire.newTab ? "noopener" : undefined);

	function citeTitle(c: number, s: ClaireSentence): string {
		const src = claire.sources.find((x) => x.id === c);

		return (src ? src.domain : "source " + String(c)) + " · entailment " + s.entail.toFixed(2);
	}
	function citeHref(c: number): string | null {
		const src = claire.sources.find((x) => x.id === c);

		return src ? safeHref(src.url) : null;
	}
	const srcHost = (s: ClaireSource) => {
		try {
			return new URL(s.url).host.replace(/^www\./, "");
		} catch {
			return s.url;
		}
	};

	// meta row parts — interleaved with .cl-dot separators like the vanilla join()
	type MetaPart = { kind: "verified"; n: number } | { kind: "text"; text: string };
	const metaParts = $derived.by((): MetaPart[] => {
		if (!claire.metaShown) {
			return [];
		}

		const parts: MetaPart[] = [];
		const verified = claire.sentences.length;

		if (verified > 0) {
			parts.push({ kind: "verified", n: verified });
		}

		if (claire.dropped > 0) {
			parts.push({
				kind: "text",
				text: `${claire.dropped} unverified claim${claire.dropped === 1 ? "" : "s"} removed`,
			});
		}

		if (claire.cached) {
			parts.push({ kind: "text", text: "cached" });
		}

		if (claire.ms >= 100) {
			parts.push({ kind: "text", text: (claire.ms / 1000).toFixed(1) + "s" });
		} // sub-100ms (cache hits) reads as noise

		return parts;
	});
</script>

{#if claire.mode !== "hidden"}
	<div id="claire">
		<section
			class="cl-card"
			class:streaming={claire.streaming}
			aria-busy={claire.streaming}
			aria-label="AI answer"
		>
			<div class="cl-head">
				<svg class="cl-spark" aria-hidden="true"><use href="#i-spark" /></svg>
				<span class="cl-name mono">Claire</span>
				<span class="cl-private mono" hidden={!claire.isPrivate}
					><svg aria-hidden="true"><use href="#i-shield" /></svg>private</span
				>
				<span class="cl-status mono" aria-live="polite">{claire.status}</span>
			</div>
			<div class="cl-body">
				{#if claire.mode === "thinking"}
					<div class="cl-sk" aria-hidden="true"><i></i><i></i></div>
				{:else if claire.mode === "answer"}
					<p class="cl-answer" class:cl-fade={!claire.animate}>
						{#each claire.sentences as s, i (i)}
							<span class="cl-sent" class:cl-noanim={!claire.animate}
								>{s.text}{#each s.cites as c, ci (ci)}{@const href = citeHref(c)}{#if href}<a
											class="cl-cite"
											{href}
											target={tgt}
											{rel}
											title={citeTitle(c, s)}>{c}</a
										>{:else}<span class="cl-cite" title={citeTitle(c, s)}>{c}</span
										>{/if}{/each}&#32;</span
							>
						{/each}
					</p>
				{:else if claire.mode === "abstain"}
					<div class="cl-abstain cl-fade">
						<p class="cl-abstain-t">No verified answer.</p>
						<p class="cl-abstain-s">
							{claire.message ||
								"Nothing in the sources cleared verification, so Claire stays quiet."}
						</p>
						{#if claire.reason}<span class="cl-tag mono">{claire.reason}</span>{/if}
					</div>
				{:else if claire.mode === "consent"}
					<div class="cl-consent cl-fade">
						<p class="cl-consent-t">{claire.message}</p>
						<button
							type="button"
							class="cl-btn"
							onclick={() => {
								claire.consentPrivately();
							}}>Answer privately</button
						>
						<span class="cl-hint mono">runs on this box, never leaves</span>
					</div>
				{:else if claire.mode === "limited"}
					<div class="cl-quiet cl-fade">
						<svg aria-hidden="true"><use href="#i-hourglass" /></svg>
						<span>Answers are rate limited for a moment. Search results are unaffected.</span>
					</div>
				{:else if claire.mode === "error"}
					<div class="cl-quiet cl-fade">
						<svg aria-hidden="true"><use href="#i-alert" /></svg>
						<span>{claire.errorDetail}</span>
						<button
							type="button"
							class="cl-retry"
							onclick={() => {
								claire.retry();
							}}><svg aria-hidden="true"><use href="#i-retry" /></svg>Try again</button
						>
					</div>
				{/if}
			</div>
			<div class="cl-foot" hidden={!claire.footShown}>
				<div class="cl-sources">
					{#each claire.sources as s, i (i)}
						{@const href = safeHref(s.url)}
						{@const delay = claire.sourcesStagger ? `${i * 45}ms` : undefined}
						{#snippet chipInner()}
							{#if claire.isPrivate}
								<!-- private route: no off-box favicon fetch ("runs on this box, never leaves" must stay true) -->
								<svg class="cl-src-ico" aria-hidden="true"><use href="#i-shield" /></svg>
							{:else}
								<img
									src="https://favicons.petalcat.dev/favicon?url={encodeURIComponent(
										'https://' + srcHost(s),
									)}&size=32"
									alt=""
									decoding="async"
									onerror={(e) => {
										(e.currentTarget as HTMLElement).remove();
									}}
								/>
							{/if}
							<b class="mono">{s.id}</b><span>{s.domain}</span>
						{/snippet}
						{#if href}
							<a class="cl-src" {href} target={tgt} {rel} style:animation-delay={delay}
								>{@render chipInner()}</a
							>
						{:else}
							<span class="cl-src" style:animation-delay={delay}>{@render chipInner()}</span>
						{/if}
					{/each}
				</div>
				<div class="cl-meta mono">
					{#each metaParts as p, i (i)}
						{#if i > 0}<span class="cl-dot" aria-hidden="true"></span>{/if}
						{#if p.kind === "verified"}
							<span class="cl-verified"
								><svg class="cl-ok" aria-hidden="true"><use href="#i-check" /></svg>{p.n} claim{p.n ===
								1
									? ""
									: "s"} verified against sources</span
							>
						{:else}
							<span>{p.text}</span>
						{/if}
					{/each}
				</div>
			</div>
		</section>
	</div>
{/if}
