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
		return "▮".repeat(n) + "▯".repeat(4 - n);
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

<svelte:window onkeydown={ready ? onKey : undefined} />

<main bind:this={screen} tabindex="-1" role="application" aria-label="whoami fingerprint inventory">
	<div class="titlebar">
		<span>whoami(1) &middot; fingerprint inventory</span>
		<span class="tb-right">{ready ? `${String(signals.length)} signals` : "loading"}</span>
	</div>

	<div class="body">
		{#if carried && linkResult}
			<div class="frame banner {linkResult}">
				<div class="ftitle">cross-context test</div>
				{#if linkResult === "match"}
					<span class="hot">&#9673; LINKABLE</span> &mdash; {hash} derived on both sides, identical &rarr;
					whatever you changed (incognito / container / VPN) did not break the link.
				{:else}
					<span class="cool">&#9678; NOT LINKED</span> &mdash; {hash} vs {carried.hash} &rarr; farbling
					/ RFP / a different device broke the cross-context link.
				{/if}
			</div>
		{/if}

		{#if !ready}
			<p class="load">reading signals<span class="cur" aria-hidden="true">▁</span></p>
		{:else}
			<!-- VERDICT -->
			<div class="frame verdict {verdict}">
				<div class="ftitle">verdict</div>
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
									<span class="tw">{expanded.has(c.id) ? "▾" : "▸"}</span>
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

			<!-- LINKABILITY -->
			<div class="frame">
				<div class="ftitle">can they follow you</div>
				<div class="lk">
					<code class="hash">{hash}</code>
					<button class="tbtn" onclick={copyUrl}
						>[ {copied ? "copied ✓" : "copy compare-link"} ]</button
					>
					{#if siblingHost}<button class="tbtn" onclick={jumpSibling}
							>[ test &rarr; sibling ]</button
						>{/if}
				</div>
				<p class="muted sm">
					Open the link in incognito / a container / VPN-on. Same hash = still trackable (a VPN
					moves your IP, not your canvas).{#if siblingHost}
						The sibling is a subdomain &mdash; same site, so we isolate manually (hash only, no
						cookies).{/if}
				</p>
				<p class="muted sm">
					~{entropySum} bits stable &mdash; a sum, and correlated, so real joint entropy is lower. It's
					the buildup, not any one line.
				</p>
			</div>

			<!-- INVENTORY -->
			{#each grouped as [cat, items] (cat)}
				<section class="frame">
					<div class="ftitle">{CATEGORY_LABELS[cat]}</div>
					{#each items as s (s.id)}
						{@const q = quadrant(s)}
						<div
							class="row q-{q}"
							class:sel={s.id === selectedId}
							data-id={s.id}
							role="button"
							tabindex="-1"
							onclick={() => {
								selectRow(s.id);
							}}
							onkeydown={(e) => {
								if (e.key === "Enter") selectRow(s.id);
							}}
						>
							<span class="g" aria-hidden="true">{expanded.has(s.id) ? "▾" : "·"}</span>
							<span class="lab">{s.label}</span>
							<span class="val">{s.value}</span>
							<span class="bars" title="{String(s.entropy)} bits (relative)">{bars(s.entropy)}</span
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
				</section>
			{/each}

			<!-- SERVER -->
			<section class="frame">
				<div class="ftitle">what the server saw</div>
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
				<p class="muted sm">
					No JA3 / header-order here &mdash; a Cloudflare tunnel terminates TLS and normalises
					headers, so the ClientHello never reaches origin (needs CF Enterprise).
				</p>
			</section>

			<!-- EXTENSIONS -->
			<section class="frame">
				<div class="ftitle">installed extensions</div>
				{#if extFindings.length}
					{#each extFindings as f (f.id)}
						<div
							class="row"
							role="button"
							tabindex="-1"
							onclick={() => {
								toggle(f.id);
							}}
							onkeydown={(e) => {
								if (e.key === "Enter") toggle(f.id);
							}}
						>
							<span class="g">{expanded.has(f.id) ? "▾" : "▸"}</span>
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
				<p class="muted sm">
					Detection is by CSS style-injection with a baseline control &mdash; a clean result is
					ambiguous (no extension, OR a defense reroutes getComputedStyle). And a userstyle manager
					(Stylus, Zen) only injects on sites it targets, so one that doesn't target this domain
					genuinely won't show here.
				</p>
			</section>
		{/if}
	</div>

	<div class="statusbar">
		{#if ready}
			<span>&uarr;&darr; move &nbsp; ⏎ expand &nbsp; click to select</span>
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
		--bg: #020a06;
		--fg: #4ee87a;
		--bright: #b9ffcf;
		--dim: #2f8f52;
		--line: #164f2e;
		--sel: #4ee87a;
		--danger: #ff5f56;
		--warn: #ffcf5a;
		--blue: #58a6ff;
	}
	:global(html) {
		background: var(--bg);
	}
	:global(body) {
		margin: 0;
		background: var(--bg);
		color: var(--fg);
		font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
		font-size: 13.5px;
		line-height: 1.5;
		-webkit-font-smoothing: antialiased;
	}
	:global(body)::before {
		content: "";
		position: fixed;
		inset: 0;
		z-index: 0;
		pointer-events: none;
		background: repeating-linear-gradient(
			0deg,
			rgba(0, 0, 0, 0.15) 0,
			rgba(0, 0, 0, 0.15) 1px,
			transparent 1px,
			transparent 3px
		);
	}

	main {
		position: relative;
		z-index: 1;
		max-width: 62rem;
		margin-inline: auto;
		min-height: 100vh;
		display: flex;
		flex-direction: column;
		border-inline: 1px solid var(--line);
		outline: none;
	}

	/* reverse-video title + status bars */
	.titlebar,
	.statusbar {
		background: var(--fg);
		color: var(--bg);
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.2rem 0.7rem;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
	}
	.statusbar {
		position: sticky;
		bottom: 0;
	}
	.sb-v.contradictions {
		color: #5a0f0b;
	}
	.tb-right,
	.sb-right {
		font-weight: 400;
	}

	.body {
		flex: 1;
		padding: 0.9rem 0.8rem 1.4rem;
	}
	.load {
		color: var(--fg);
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
		color: var(--dim);
	}
	.sm {
		font-size: 0.82rem;
		max-width: 74ch;
		margin: 0.5rem 0 0;
	}

	/* box-drawing panels: border with the title breaking the top rule */
	.frame {
		position: relative;
		border: 1px solid var(--line);
		padding: 0.7rem 0.7rem 0.6rem;
		margin-top: 1.3rem;
	}
	.frame:first-child {
		margin-top: 0.4rem;
	}
	.ftitle {
		position: absolute;
		top: -0.72em;
		left: 0.7rem;
		background: var(--bg);
		padding: 0 0.4rem;
		font-size: 0.7rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--dim);
	}

	/* verdict */
	.verdict.contradictions {
		border-color: var(--danger);
	}
	.verdict.contradictions .ftitle {
		color: var(--danger);
	}
	.vline {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
		flex-wrap: wrap;
		font-size: 1.05rem;
	}
	.dot {
		color: var(--fg);
	}
	.verdict.minor .dot {
		color: var(--warn);
	}
	.verdict.contradictions .dot {
		color: var(--danger);
	}
	.vt {
		color: var(--bright);
		letter-spacing: 0.04em;
	}
	.verdict.contradictions .vt {
		color: var(--danger);
	}

	.cx {
		list-style: none;
		padding: 0;
		margin: 0.6rem 0 0;
	}
	.cxrow {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		width: 100%;
		text-align: left;
		background: none;
		border: none;
		color: var(--bright);
		font: inherit;
		padding: 0.15rem 0;
		cursor: pointer;
	}
	.cxrow:focus-visible {
		outline: 1px solid var(--fg);
	}
	.tw {
		color: var(--dim);
	}
	.sev {
		font-size: 0.62rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		padding: 0 0.3rem;
		border: 1px solid currentColor;
	}
	.sev-high .sev {
		color: var(--danger);
	}
	.sev-medium .sev {
		color: var(--warn);
	}
	.sev-info .sev {
		color: var(--dim);
	}
	.cxdetail {
		color: var(--dim);
		padding: 0 0 0.4rem 1.5rem;
		max-width: 76ch;
	}
	.ev {
		margin-top: 0.3rem;
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem 1.1rem;
		color: var(--bright);
		font-size: 0.82rem;
		word-break: break-all;
	}
	.evk {
		color: var(--dim);
		text-transform: uppercase;
		font-size: 0.66rem;
	}

	/* linkability */
	.lk {
		display: flex;
		align-items: baseline;
		gap: 0.8rem;
		flex-wrap: wrap;
	}
	.hash {
		font-size: clamp(1.5rem, 5vw, 2.2rem);
		color: var(--bright);
		letter-spacing: 0.06em;
	}
	.tbtn {
		font: inherit;
		font-size: 0.82rem;
		color: var(--bright);
		background: none;
		border: none;
		padding: 0.2rem 0;
		cursor: pointer;
	}
	.tbtn:hover,
	.tbtn:focus-visible {
		color: var(--bg);
		background: var(--fg);
		outline: none;
	}
	.banner.match {
		border-color: var(--danger);
	}
	.banner .hot {
		color: var(--danger);
	}
	.banner .cool {
		color: var(--fg);
	}

	/* rows */
	.row {
		display: grid;
		grid-template-columns: 1.1rem minmax(7rem, 11rem) minmax(0, 1fr) auto auto;
		align-items: baseline;
		gap: 0.6rem;
		padding: 0.12rem 0.35rem;
		cursor: pointer;
		border: none;
		background: none;
		width: 100%;
		text-align: left;
		font: inherit;
		color: inherit;
	}
	.row.sel {
		background: var(--sel);
		color: var(--bg);
	}
	.row.sel .lab,
	.row.sel .val,
	.row.sel .bars,
	.row.sel .rt,
	.row.sel .g {
		color: var(--bg);
		border-color: var(--bg);
	}
	.g {
		color: var(--dim);
	}
	.q-dangerous .g {
		color: var(--danger);
	}
	.q-standardized .g {
		color: var(--bright);
	}
	.q-randomized .g {
		color: var(--blue);
	}
	.lab {
		color: var(--dim);
	}
	.val {
		color: var(--bright);
		word-break: break-word;
	}
	.bars {
		color: var(--fg);
		letter-spacing: -1px;
		font-size: 0.8rem;
		white-space: nowrap;
	}
	.rt {
		font-size: 0.6rem;
		letter-spacing: 0.04em;
		padding: 0 0.25rem;
		border: 1px solid;
		white-space: nowrap;
	}
	.r-stable {
		color: var(--fg);
		border-color: var(--line);
	}
	.r-randomized {
		color: var(--blue);
		border-color: #1f4a6e;
	}
	.r-standardized {
		color: var(--bright);
		border-color: var(--line);
	}
	.r-volatile {
		color: var(--dim);
		border-color: var(--line);
	}
	.detail {
		padding: 0.2rem 0 0.4rem 1.7rem;
		max-width: 78ch;
	}
	.dnote {
		color: var(--dim);
		font-size: 0.85rem;
		line-height: 1.5;
	}
	.ddev {
		color: var(--dim);
		font-size: 0.8rem;
		margin-top: 0.2rem;
	}

	/* server */
	.srow {
		display: grid;
		grid-template-columns: minmax(7rem, 11rem) minmax(0, 1fr) auto;
		gap: 0.6rem;
		padding: 0.12rem 0.35rem;
	}
	.sk {
		color: var(--dim);
		text-transform: uppercase;
		font-size: 0.72rem;
	}
	.sv {
		color: var(--bright);
		word-break: break-word;
	}

	@media (max-width: 40rem) {
		.row {
			grid-template-columns: 1.1rem 1fr auto;
		}
		.row .val {
			grid-column: 2 / 4;
		}
		.row .bars {
			display: none;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.cur {
			animation: none;
		}
	}
</style>
