<script lang="ts">
	import {
		collectSignals,
		linkabilityHash,
		CATEGORY_LABELS,
		type Signal,
		type SignalCategory,
		type Repro,
	} from "$lib/collect";
	import {
		checkConsistency,
		verdictOf,
		type Contradiction,
		type EdgeTrace,
		type Verdict,
	} from "$lib/consistency";
	import { detectExtensions, type ExtFinding } from "$lib/extensions";
	import {
		readCarriedRef,
		buildJumpUrl,
		compareHashes,
		type CarriedRef,
		type LinkResult,
	} from "$lib/linkability";
	import { fetchTrace } from "$lib/trace";
	import { SvelteSet } from "svelte/reactivity";

	import type { PageData } from "./$types";

	let { data }: { data: PageData } = $props();

	let signals = $state<Signal[]>([]);
	let hash = $state("");
	let trace = $state<EdgeTrace | null>(null);
	let contradictions = $state<Contradiction[]>([]);
	let verdict = $state<Verdict>("coherent");
	let extFindings = $state<ExtFinding[]>([]);
	let extRan = $state(false);
	let carried = $state<CarriedRef | null>(null);
	let linkResult = $state<LinkResult | null>(null);
	let ready = $state(false);
	let copied = $state(false);

	// TUI interaction: a selected row (keyboard-driven, reverse-video) and a set of
	// expanded rows. No hover — a terminal highlights what's selected, and reveals
	// detail on enter, it doesn't glow under the cursor.
	let selectedId = $state("");
	const expanded = new SvelteSet<string>();
	let screen = $state<HTMLElement | null>(null);

	const SIBLINGS: Record<string, string> = {
		"fingerprint.petalcat.dev": "fingerprint-b.petalcat.dev",
		"fingerprint-b.petalcat.dev": "fingerprint.petalcat.dev",
	};
	let siblingHost = $state<string | undefined>(undefined);

	// canvas / audio / webgl can be RANDOMISED without a single page load being able
	// to tell — FPP/farbling keep them stable within a session. We label them STABLE?
	// and defer to the linkability test rather than assert they link you.
	const UNVERIFIED = new Set([
		"canvas.digest",
		"audio.digest",
		"webgl.renderer",
		"webgl.vendor",
		"webgl.digest",
	]);

	$effect(() => {
		const ctx = { alive: true };
		carried = readCarriedRef();
		siblingHost = typeof window !== "undefined" ? SIBLINGS[window.location.host] : undefined;

		void (async () => {
			const [sigs, tr, ext] = await Promise.all([
				collectSignals(),
				fetchTrace(),
				detectExtensions(),
			]);
			if (!ctx.alive) return;
			signals = sigs;
			hash = linkabilityHash(sigs);
			trace = tr;
			extFindings = ext.findings;
			extRan = ext.ran;
			selectedId = sigs[0]?.id ?? "";

			const n = navigator;
			contradictions = checkConsistency(data.server, tr, {
				userAgent: n.userAgent,
				language: n.language,
				languages: [...n.languages],
				platform: n.platform,
				vendor: n.vendor,
				deviceMemory: (n as unknown as { deviceMemory?: number }).deviceMemory,
				maxTouchPoints: n.maxTouchPoints,
				dpr: window.devicePixelRatio,
				timezone: sigs.find((s) => s.id === "intl.timeZone")?.value ?? "",
				utcOffsetMin: new Date().getTimezoneOffset(),
			});
			verdict = verdictOf(contradictions);
			if (carried) linkResult = compareHashes(hash, carried.hash);
			ready = true;
			queueMicrotask(() => screen?.focus());
		})();

		return () => {
			ctx.alive = false;
		};
	});

	const grouped = $derived.by(() => {
		const order: SignalCategory[] = [];
		for (const s of signals) {
			if (!order.includes(s.category)) order.push(s.category);
		}
		return order.map((cat): [SignalCategory, Signal[]] => [
			cat,
			signals.filter((s) => s.category === cat),
		]);
	});
	const flatIds = $derived(signals.map((s) => s.id));

	const entropySum = $derived(
		Math.round(signals.reduce((a, s) => a + (s.reproducibility === "stable" ? s.entropy : 0), 0)),
	);

	type Quad = "dangerous" | "linking" | "randomized" | "standardized" | "volatile" | "common";
	function quadrant(s: Signal): Quad {
		if (s.reproducibility === "randomized") return "randomized";
		if (s.reproducibility === "standardized") return "standardized";
		if (s.reproducibility === "volatile") return "volatile";
		if (s.entropy >= 3) return "dangerous";
		if (s.entropy >= 1) return "linking";
		return "common";
	}

	function bars(e: number): string {
		const n = e >= 7 ? 4 : e >= 4 ? 3 : e >= 2 ? 2 : e >= 1 ? 1 : 0;
		return "█".repeat(n) + "░".repeat(4 - n);
	}
	function tag(s: Signal): string {
		const r = s.reproducibility;
		if (r === "stable") return UNVERIFIED.has(s.id) ? "STABLE?" : "STABLE";
		if (r === "randomized") return "RAND";
		if (r === "standardized") return "STD";
		return "VOL";
	}
	const REPRO_TITLE: Record<Repro, string> = {
		stable: "re-derivable and stable — links you over time and across sites",
		randomized:
			"randomized per session — does NOT link you cross-session, but almost nobody randomizes, so doing it marks you as unusual (the too-unique trap)",
		standardized: "forced to a shared common value — low entropy by design, blends in",
		volatile: "drifts on its own over time — a weak linker",
	};
	function tagTitle(s: Signal): string {
		if (s.reproducibility === "stable" && UNVERIFIED.has(s.id)) {
			return "a single page load can't tell if this is randomised (FPP keeps it stable within a session) — run the linkability test to find out";
		}
		return REPRO_TITLE[s.reproducibility];
	}

	const VTEXT: Record<Verdict, string> = {
		coherent: "COHERENT",
		minor: "MINOR MISMATCHES",
		contradictions: "CONTRADICTIONS",
	};

	function toggle(id: string) {
		if (expanded.has(id)) expanded.delete(id);
		else expanded.add(id);
	}
	function selectRow(id: string) {
		selectedId = id;
		toggle(id);
	}

	function onKey(e: KeyboardEvent) {
		if (!flatIds.length) return;
		const i = flatIds.indexOf(selectedId);
		if (e.key === "ArrowDown" || e.key === "j") {
			e.preventDefault();
			selectedId = flatIds[Math.min(i + 1, flatIds.length - 1)];
			scrollSel();
		} else if (e.key === "ArrowUp" || e.key === "k") {
			e.preventDefault();
			selectedId = flatIds[Math.max(i - 1, 0)];
			scrollSel();
		} else if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			toggle(selectedId);
		} else if (e.key === "Home") {
			e.preventDefault();
			selectedId = flatIds[0];
			scrollSel();
		} else if (e.key === "End") {
			e.preventDefault();
			selectedId = flatIds[flatIds.length - 1];
			scrollSel();
		}
	}
	function scrollSel() {
		queueMicrotask(() =>
			screen
				?.querySelector(`[data-id="${CSS.escape(selectedId)}"]`)
				?.scrollIntoView({ block: "nearest" }),
		);
	}

	async function copyUrl() {
		try {
			await navigator.clipboard.writeText(buildJumpUrl(hash));
			copied = true;
			setTimeout(() => (copied = false), 1600);
		} catch {
			/* clipboard blocked */
		}
	}
	function jumpSibling() {
		if (siblingHost) window.location.href = buildJumpUrl(hash, siblingHost);
	}

	const dotChar: Record<Verdict, string> = {
		coherent: "●",
		minor: "●",
		contradictions: "●",
	};
</script>

{#snippet btop(t: string)}
	<div class="btop">
		<span class="c" aria-hidden="true">┌──</span><span class="btt">{t}</span><span
			class="bfill"
			aria-hidden="true"
		></span><span class="c" aria-hidden="true">┐</span>
	</div>
{/snippet}
{#snippet bbot()}
	<div class="bbot" aria-hidden="true"><span class="c">└</span><span class="bfill"></span><span class="c">┘</span></div>
{/snippet}

<svelte:window onkeydown={ready ? onKey : undefined} />

<main bind:this={screen} tabindex="-1" aria-label="whoami fingerprint inventory">
	<div class="topbar">
		<span><span class="bright">whoami</span>(1)<span class="tb-sub"> — fingerprint inventory</span></span>
		<span class="tb-right">{ready ? `${String(signals.length)} signals` : "loading…"}</span>
	</div>
	<div class="hr" aria-hidden="true"></div>

	<div class="body">
		{#if carried && linkResult}
			<section class="box {linkResult}">
				{@render btop("cross-context test")}
				<div class="bin">
					{#if linkResult === "match"}
						<span class="hot">LINKABLE</span> &mdash; {hash} derived on both sides, identical &rarr; whatever
						you changed (incognito / container / VPN) did not break the link.
					{:else}
						<span class="cool">NOT LINKED</span> &mdash; {hash} vs {carried.hash} &rarr; farbling / RFP
						/ a different device broke the cross-context link.
					{/if}
				</div>
				{@render bbot()}
			</section>
		{/if}

		{#if !ready}
			<p class="load">reading signals<span class="cur" aria-hidden="true">█</span></p>
		{:else}
			<!-- VERDICT -->
			<section class="box verdict {verdict}">
				{@render btop("verdict")}
				<div class="bin">
					<div class="vline">
						<span class="dot" aria-hidden="true">{dotChar[verdict]}</span>
						<span class="vt"
							>{VTEXT[verdict]}{verdict === "contradictions"
								? ` (${String(contradictions.length)})`
								: ""}</span
						>
						<span class="muted"
							>{verdict === "coherent"
								? "headers, edge & JS agree"
								: "surfaces disagree — a real machine can't"}</span
						>
					</div>
					{#if contradictions.length}
						<ul class="cx">
							{#each contradictions as c (c.id)}
								<li class="sev-{c.severity}">
									<button
										class="cxrow"
										onclick={() => {
											toggle(c.id);
										}}
									>
										<span class="tw" aria-hidden="true">{expanded.has(c.id) ? "[-]" : "[+]"}</span>
										<span class="sev">{c.severity}</span>
										<span class="cxtitle">{c.title}</span>
									</button>
									{#if expanded.has(c.id)}
										<div class="cxdetail">
											{c.detail}
											<div class="ev">
												{#each c.evidence as e (e.label)}
													<span><span class="evk">{e.label}</span> {e.value}</span>
												{/each}
											</div>
										</div>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
				</div>
				{@render bbot()}
			</section>

			<!-- LINKABILITY -->
			<section class="box">
				{@render btop("can they follow you")}
				<div class="bin">
					<div class="lk">
						<code class="hash">{hash}</code>
						<button class="tbtn" onclick={copyUrl}
							>[ {copied ? "copied" : "copy compare-link"} ]</button
						>
						{#if siblingHost}<button class="tbtn" onclick={jumpSibling}
								>[ test &rarr; sibling ]</button
							>{/if}
						<button
							class="tbtn"
							onclick={() => {
								toggle("why:link");
							}}>[ {expanded.has("why:link") ? "-" : "?"} why ]</button
						>
					</div>
					{#if expanded.has("why:link")}
						<p class="muted sm">
							Open the link in incognito / a container / VPN-on. Same hash = still trackable (a VPN
							moves your IP, not your canvas).{#if siblingHost}
								The sibling is a subdomain &mdash; same site, so we isolate manually (hash only, no
								cookies).{/if}
						</p>
						<p class="muted sm">
							~{entropySum} bits stable &mdash; a sum, and correlated, so real joint entropy is lower.
							It's the buildup, not any one line.
						</p>
					{/if}
				</div>
				{@render bbot()}
			</section>

			<!-- INVENTORY -->
			{#each grouped as [cat, items] (cat)}
				<section class="box">
					{@render btop(CATEGORY_LABELS[cat])}
					<div class="bin">
						{#each items as s (s.id)}
							{@const q = quadrant(s)}
							<div
								class="row q-{q}"
								class:sel={s.id === selectedId}
								data-id={s.id}
								role="button"
								tabindex="0"
								aria-expanded={expanded.has(s.id)}
								onclick={() => {
									selectRow(s.id);
								}}
								onkeydown={(e) => {
									if (e.key === "Enter") selectRow(s.id);
								}}
							>
								<span class="g" aria-hidden="true">{expanded.has(s.id) ? "[-]" : "[+]"}</span>
								<span class="lab">{s.label}</span>
								<span class="val">{s.value}</span>
								<span class="bars" aria-hidden="true" title="{String(s.entropy)} bits (relative)">{bars(s.entropy)}</span
								>
								<span class="rt r-{s.reproducibility}" title={tagTitle(s)}>{tag(s)}</span>
							</div>
							{#if expanded.has(s.id)}
								<div class="detail" class:sel-detail={s.id === selectedId}>
									<div class="dnote">{s.note}</div>
									<div class="ddev">you: {s.value} &nbsp;&middot;&nbsp; typical: {s.typical}</div>
								</div>
							{/if}
						{/each}
					</div>
					{@render bbot()}
				</section>
			{/each}

			<!-- SERVER -->
			<section class="box">
				{@render btop("what the server saw")}
				<div class="bin">
					<div class="srow">
						<span class="sk">IP</span><span class="sv">{data.server.ip ?? "—"}</span><span
							class="muted sm">your own; not stored</span
						>
					</div>
					{#if trace}
						<div class="srow">
							<span class="sk">WARP</span><span class="sv">{trace.warp ?? "?"}</span
							>{#if trace.warp === "on" || trace.warp === "plus"}<span class="muted sm"
									>edge IP is Cloudflare's, not you</span
								>{/if}
						</div>
						<div class="srow">
							<span class="sk">gateway</span><span class="sv">{trace.gateway ?? "?"}</span>
						</div>
						<div class="srow">
							<span class="sk">edge loc</span><span class="sv">{trace.loc ?? "?"}</span>
						</div>
						<div class="srow">
							<span class="sk">TLS</span><span class="sv">{trace.tls ?? "?"}</span><span
								class="muted sm">colo {trace.colo ?? "?"}</span
							>
						</div>
					{/if}
					<div class="srow">
						<span class="sk">Accept-Lang</span><span class="sv"
							>{data.server.acceptLanguage ?? "—"}</span
						>
					</div>
					<div class="srow">
						<span class="sk">Sec-CH-UA</span><span class="sv"
							>{data.server.secChUa ?? "absent (FF/Safari)"}</span
						>
					</div>
				</div>
				{@render bbot()}
			</section>

			<!-- EXTENSIONS -->
			<section class="box">
				{@render btop("installed extensions")}
				<div class="bin">
					{#if extFindings.length}
						{#each extFindings as f (f.id)}
							<div
								class="row"
								role="button"
								tabindex="0"
								aria-expanded={expanded.has(f.id)}
								onclick={() => {
									toggle(f.id);
								}}
								onkeydown={(e) => {
									if (e.key === "Enter") toggle(f.id);
								}}
							>
								<span class="g" aria-hidden="true">{expanded.has(f.id) ? "[-]" : "[+]"}</span>
								<span class="lab">{f.name}</span>
								<span class="rt">{f.confidence}</span>
							</div>
							{#if expanded.has(f.id)}
								<div class="detail">
									<div class="dnote">{f.detail} <span class="muted">({f.method})</span></div>
								</div>
							{/if}
						{/each}
					{:else if extRan}
						<p class="muted sm">none detected via CSS-injection probes.</p>
					{/if}
					<button
						class="tbtn"
						onclick={() => {
							toggle("why:ext");
						}}>[ {expanded.has("why:ext") ? "-" : "?"} how ]</button
					>
					{#if expanded.has("why:ext")}
						<p class="muted sm">
							Detection is by CSS style-injection with a baseline control &mdash; a clean result is
							ambiguous (no extension, OR a defense reroutes getComputedStyle). And a userstyle manager
							(Stylus, Zen) only injects on sites it targets, so one that doesn't target this domain
							genuinely won't show here.
						</p>
					{/if}
				</div>
				{@render bbot()}
			</section>
		{/if}
	</div>

	<div class="statusbar">
		{#if ready}
			<span class="hint-kbd">j/k move &nbsp; ⏎ expand &nbsp; :q</span>
			<span class="hint-touch">tap a row to expand</span>
			<span class="sb-right"
				>~{entropySum} bits &nbsp;&middot;&nbsp;
				<span class="sb-v {verdict}"
					>{VTEXT[verdict]}{verdict === "contradictions"
						? ` ${String(contradictions.length)}`
						: ""}</span
				></span
			>
		{:else}
			<span>initialising…</span>
		{/if}
	</div>
</main>

<style>
	:global(:root) {
		/* macOS Terminal.app "Homebrew" — pure black + #00ff00, real ANSI accents */
		--bg: #000000;
		--fg: #00ff00;
		--dim: #00a600;
		/* pure macOS Terminal.app "Homebrew" — authenticity kept over WCAG AA
		   contrast on muted/red per Eli's call */
		--muted: #666666;
		--bright: #e5e5e5;
		--red: #e50000;
		--yellow: #e5e500;
		--cyan: #00e5e5;
		--cursor: #23ff18;
	}
	:global(html) {
		background: var(--bg);
	}
	:global(body) {
		margin: 0;
		background: var(--bg);
		color: var(--fg);
		font-family: "SF Mono", "JetBrains Mono", Menlo, Consolas, ui-monospace, monospace;
		/* one cell size everywhere; tight character grid, not airy */
		font-size: 15px;
		line-height: 1.2;
		-webkit-font-smoothing: antialiased;
	}

	/* full-width, left-aligned — terminals don't center a column */
	main {
		display: flex;
		flex-direction: column;
		min-height: 100vh;
		max-width: 100%;
		overflow-x: clip;
		outline: none;
	}
	:global(*) {
		box-sizing: border-box;
	}

	.bright {
		color: var(--bright);
		font-weight: 700;
	}

	/* top: a plain title line + a full-width box-drawing rule (not a heavy bar) */
	.topbar {
		display: flex;
		justify-content: space-between;
		gap: 1ch;
		padding: 0.2rem 1ch 0;
		color: var(--fg);
		white-space: nowrap;
	}
	.tb-right {
		color: var(--dim);
	}
	.hr {
		overflow: hidden;
		white-space: nowrap;
		color: var(--dim);
		padding: 0 1ch;
	}
	.hr::after {
		content: "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────";
	}

	.body {
		flex: 1;
		padding: 0.3rem 1ch 2rem;
	}
	.load {
		color: var(--fg);
		padding: 0.6rem 1ch;
	}
	.cur {
		animation: blink 1.1s steps(1) infinite;
	}
	@keyframes blink {
		50% {
			opacity: 0;
		}
	}
	.muted {
		color: var(--muted);
	}
	.sm {
		max-width: 92ch;
		margin: 0.4rem 0 0;
	}

	/* real box-drawing: glyph corners + a flex-filled ─ rule, thin sides join them */
	.box {
		margin-top: 0.8rem;
		position: relative;
	}
	/* sides drawn as real │ glyphs at the exact corner columns (left:0 aligns
	   with ┌/└, right:0 with ┐/┘) — same glyph cell as the corners, so the
	   strokes line up. not a CSS border (that sat off the glyph stroke). */
	.box::before,
	.box::after {
		content: "│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A│\A";
		position: absolute;
		top: 1.2em;
		bottom: 1.2em;
		white-space: pre;
		line-height: 0.92;
		color: var(--dim);
		overflow: hidden;
		pointer-events: none;
	}
	.box::before {
		left: 0;
	}
	.box::after {
		right: 0;
	}
	.btop,
	.bbot {
		display: flex;
		align-items: center;
		color: var(--dim);
		white-space: nowrap;
	}
	.c {
		color: var(--dim);
	}
	.btt {
		text-transform: uppercase;
		letter-spacing: 0.1em;
		padding: 0 1ch;
		color: var(--dim);
	}
	.bfill {
		flex: 1;
		overflow: hidden;
	}
	.bfill::after {
		content: "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────";
	}
	.bin {
		/* clears the │ glyph rails drawn by .box::before/::after */
		padding: 0.25rem 2ch 0.35rem;
	}

	.verdict.contradictions .c,
	.verdict.contradictions .btt {
		color: var(--red);
	}

	.vline {
		display: flex;
		align-items: baseline;
		gap: 1ch;
		flex-wrap: wrap;
	}
	.dot {
		color: var(--fg);
	}
	.verdict.minor .dot {
		color: var(--yellow);
	}
	.verdict.contradictions .dot {
		color: var(--red);
	}
	.vt {
		color: var(--bright);
	}
	.verdict.contradictions .vt {
		color: var(--red);
	}

	.cx {
		list-style: none;
		padding: 0;
		margin: 0.4rem 0 0;
	}
	.cxrow {
		display: flex;
		align-items: baseline;
		gap: 1ch;
		width: 100%;
		text-align: left;
		background: none;
		border: none;
		color: var(--fg);
		font: inherit;
		padding: 0.05rem 0;
		cursor: pointer;
	}
	.cxrow:focus-visible {
		outline: 1px solid var(--fg);
	}
	.tw {
		color: var(--dim);
	}
	.sev {
		text-transform: uppercase;
	}
	.sev::before {
		content: "[";
	}
	.sev::after {
		content: "]";
	}
	.sev-high .sev {
		color: var(--red);
	}
	.sev-medium .sev {
		color: var(--yellow);
	}
	.sev-info .sev {
		color: var(--muted);
	}
	.cxdetail {
		color: var(--muted);
		padding: 0 0 0.3rem 4ch;
		max-width: 92ch;
	}
	.ev {
		margin-top: 0.2rem;
		display: flex;
		flex-wrap: wrap;
		gap: 0.2rem 2ch;
		color: var(--fg);
		word-break: break-all;
	}
	.evk {
		color: var(--dim);
		text-transform: uppercase;
	}

	/* linkability */
	.lk {
		display: flex;
		align-items: baseline;
		gap: 2ch;
		flex-wrap: wrap;
	}
	.hash {
		color: var(--bright);
		font-weight: 700;
		letter-spacing: 0.12em;
	}
	.tbtn {
		font: inherit;
		color: var(--fg);
		background: none;
		border: none;
		padding: 0.1rem 0;
		cursor: pointer;
	}
	.tbtn:hover,
	.tbtn:focus-visible {
		color: var(--bg);
		background: var(--fg);
		outline: none;
	}
	.box.match .c,
	.box.match .btt {
		color: var(--red);
	}
	.hot {
		color: var(--red);
	}
	.cool {
		color: var(--fg);
	}

	/* rows */
	.row {
		display: grid;
		/* fixed bar + tag columns so every tag right-aligns in one clean column */
		grid-template-columns: 3.5ch minmax(9ch, 15ch) minmax(0, 1fr) 5ch 9ch;
		align-items: baseline;
		gap: 0 1ch;
		padding: 0.05rem 0;
		cursor: pointer;
		border: none;
		background: none;
		width: 100%;
		text-align: left;
		font: inherit;
		color: inherit;
	}
	.row:focus-visible {
		outline: 1px solid var(--fg);
		outline-offset: -1px;
	}
	.row.sel {
		background: var(--fg);
		color: var(--bg);
	}
	.row.sel .lab,
	.row.sel .val,
	.row.sel .bars,
	.row.sel .rt,
	.row.sel .g {
		color: var(--bg);
	}
	.g {
		color: var(--dim);
	}
	.q-dangerous .g {
		color: var(--red);
	}
	.q-standardized .g {
		color: var(--bright);
	}
	.q-randomized .g {
		color: var(--cyan);
	}
	.lab {
		color: var(--dim);
	}
	.val {
		color: var(--fg);
		word-break: break-word;
	}
	.bars {
		color: var(--dim);
		white-space: nowrap;
		text-align: right;
	}
	.rt {
		white-space: nowrap;
		color: var(--fg);
		text-align: right;
	}
	.rt::before {
		content: "[";
	}
	.rt::after {
		content: "]";
	}
	.r-randomized {
		color: var(--cyan);
	}
	.r-standardized {
		color: var(--bright);
	}
	.r-volatile {
		color: var(--muted);
	}
	.detail {
		padding: 0.1rem 0 0.3rem 4ch;
		max-width: 92ch;
	}
	.dnote {
		color: var(--muted);
	}
	.ddev {
		color: var(--muted);
		margin-top: 0.2rem;
	}

	/* server */
	.srow {
		display: grid;
		grid-template-columns: minmax(10ch, 14ch) minmax(0, 1fr) auto;
		gap: 0 1ch;
		padding: 0.05rem 0;
	}
	.sk {
		color: var(--dim);
		text-transform: uppercase;
	}
	.sv {
		color: var(--fg);
		word-break: break-word;
	}

	/* bottom: tmux/vim-style reverse-video status line */
	.statusbar {
		position: sticky;
		bottom: 0;
		display: flex;
		justify-content: space-between;
		gap: 1ch;
		padding: 0.15rem 1ch;
		background: var(--fg);
		color: var(--bg);
		white-space: nowrap;
		overflow: hidden;
	}
	.sb-v.contradictions {
		color: var(--red);
	}
	.hint-touch {
		display: none;
	}

	@media (max-width: 40rem) {
		.row {
			grid-template-columns: 3.5ch 1fr auto;
			grid-template-areas: "g lab tag" "g val val";
			gap: 0.05rem 1ch;
			padding-block: 0.35rem;
		}
		.row .g {
			grid-area: g;
			align-self: start;
		}
		.row .lab {
			grid-area: lab;
			text-transform: uppercase;
		}
		.row .val {
			grid-area: val;
		}
		.row .rt {
			grid-area: tag;
		}
		.row .bars {
			display: none;
		}
		.srow {
			grid-template-columns: 1fr;
		}
	}
	@media (hover: none) and (pointer: coarse) {
		.hint-kbd {
			display: none;
		}
		.hint-touch {
			display: inline;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.cur {
			animation: none;
		}
	}
</style>
