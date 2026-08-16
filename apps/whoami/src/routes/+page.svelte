<script lang="ts">
	import {
		collectSignals,
		linkabilityHash,
		CATEGORY_LABELS,
		REPRO_LABELS,
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

	const SIBLINGS: Record<string, string> = {
		"fingerprint.petalcat.dev": "fingerprint-b.petalcat.dev",
		"fingerprint-b.petalcat.dev": "fingerprint.petalcat.dev",
	};
	let siblingHost = $state<string | undefined>(undefined);

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
	function tag(r: Repro): string {
		return r === "stable"
			? "STABLE"
			: r === "randomized"
				? "RAND"
				: r === "standardized"
					? "STD"
					: "VOL";
	}
	const VTEXT: Record<Verdict, string> = {
		coherent: "COHERENT",
		minor: "MINOR MISMATCHES",
		contradictions: "CONTRADICTIONS",
	};

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
</script>

<main>
	<div class="prompt">
		<span class="dim">visitor@whoami</span><span class="dim">:~$</span> cat /proc/self/fingerprint<span
			class="cur"
			aria-hidden="true">█</span
		>
	</div>
	<p class="tag">
		What your browser tells every site — and whether they can follow you. Nothing leaves this page.
	</p>

	{#if carried && linkResult}
		<div class="banner {linkResult}">
			{#if linkResult === "match"}◉ LINKABLE — {hash} on both{:else}◎ NOT LINKED — {hash} vs {carried.hash}{/if}
			<span class="dim">
				{#if linkResult === "match"}derived separately, identical → whatever you changed didn't
					break the link{:else}differ → farbling / RFP / a different device broke it{/if}
			</span>
		</div>
	{/if}

	{#if !ready}
		<p class="load">reading signals<span class="cur" aria-hidden="true">▁</span></p>
	{:else}
		<div class="verdict {verdict}">
			<span class="dot" aria-hidden="true"></span>
			<span class="vt"
				>{VTEXT[verdict]}{verdict === "contradictions"
					? ` (${String(contradictions.length)})`
					: ""}</span
			>
			<span class="dim"
				>{verdict === "coherent"
					? "headers, edge & JS agree"
					: "surfaces disagree — a real machine can't"}</span
			>
		</div>
		{#if contradictions.length}
			<ul class="cx">
				{#each contradictions as c (c.id)}
					<li class="sev-{c.severity}" title={c.detail}>
						<span class="sev">{c.severity}</span>{c.title}
						<span class="ev">{c.evidence.map((e) => `${e.label}=${e.value}`).join("  ")}</span>
					</li>
				{/each}
			</ul>
		{/if}

		<div class="rule"></div>

		<div class="link">
			<div class="lk-top">
				<span class="dim">can they follow you</span>
				<code class="hash">{hash}</code>
				<button onclick={copyUrl}>{copied ? "copied ✓" : "copy compare-link"}</button>
				{#if siblingHost}<button onclick={jumpSibling}>test → {siblingHost}</button>{/if}
			</div>
			<p class="dim sm">
				Open it in incognito / a container / VPN-on. Same hash = still trackable (a VPN moves your
				IP, not your canvas).{#if siblingHost}
					A subdomain is the same site, so we isolate manually — hash only, no cookies.{/if}
			</p>
		</div>

		<div class="entropy">
			<span class="ebig">~{entropySum}</span> bits stable
			<span
				class="dim sm"
				title="Signals are correlated (canvas↔fonts↔GPU↔OS), so joint entropy is well below the sum. ~10 bits ≈ 1-in-a-million."
			>
				· sum overstates (correlated) · it's the buildup, not any one line
			</span>
		</div>

		{#each grouped as [cat, items] (cat)}
			<section>
				<h3>{CATEGORY_LABELS[cat]}</h3>
				{#each items as s (s.id)}
					{@const q = quadrant(s)}
					<div class="row q-{q}" title={s.note}>
						<span class="g" aria-hidden="true"></span>
						<span class="lab">{s.label}</span>
						<span class="val">{s.value}</span>
						<span class="bars" title="{s.entropy} bits (relative)">{bars(s.entropy)}</span>
						<span class="rt r-{s.reproducibility}" title={REPRO_LABELS[s.reproducibility]}
							>{tag(s.reproducibility)}</span
						>
						<span class="dev" title="typical value">{s.typical}</span>
					</div>
				{/each}
			</section>
		{/each}

		<section>
			<h3>what the server saw</h3>
			<div class="row srv">
				<span class="lab">IP</span><span class="val">{data.server.ip ?? "—"}</span><span
					class="dim sm">your own; not stored</span
				>
			</div>
			{#if trace}
				<div class="row srv">
					<span class="lab">WARP</span><span class="val">{trace.warp ?? "?"}</span
					>{#if trace.warp === "on" || trace.warp === "plus"}<span class="dim sm"
							>edge IP is Cloudflare's, not you</span
						>{/if}
				</div>
				<div class="row srv">
					<span class="lab">gateway</span><span class="val">{trace.gateway ?? "?"}</span>
				</div>
				<div class="row srv">
					<span class="lab">edge loc</span><span class="val">{trace.loc ?? "?"}</span>
				</div>
				<div class="row srv">
					<span class="lab">TLS</span><span class="val">{trace.tls ?? "?"}</span><span
						class="dim sm">colo {trace.colo ?? "?"}</span
					>
				</div>
			{/if}
			<div class="row srv">
				<span class="lab">Accept-Lang</span><span class="val"
					>{data.server.acceptLanguage ?? "—"}</span
				>
			</div>
			<div class="row srv">
				<span class="lab">Sec-CH-UA</span><span class="val"
					>{data.server.secChUa ?? "absent (FF/Safari)"}</span
				>
			</div>
			<p
				class="dim sm"
				title="This app is behind a Cloudflare tunnel: it terminates TLS and normalises headers, so JA3/JA4 and raw header order never reach the origin (they need CF Enterprise)."
			>
				no JA3 / header-order here — CF tunnel eats them (why?)
			</p>
		</section>

		<section>
			<h3>installed extensions</h3>
			{#if extFindings.length}
				{#each extFindings as f (f.id)}
					<div class="row srv" title={f.detail}>
						<span class="lab">▸</span><span class="val">{f.name}</span><span class="rt"
							>{f.confidence}</span
						>
					</div>
				{/each}
			{:else if extRan}
				<p
					class="dim sm"
					title="Detected by CSS style-injection with a baseline control. A clean result means no detectable extension OR a defense (Shadow-DOM getComputedStyle reroute) is active — absence isn't proof."
				>
					none detected — but clean is ambiguous (why?)
				</p>
			{/if}
		</section>

		<footer>read-only · no storage · no logs</footer>
	{/if}
</main>

<style>
	:global(html) {
		background: #020a06;
	}
	:global(body) {
		margin: 0;
		background: #020a06;
		color: #4ee87a;
		font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
		font-size: 14px;
		line-height: 1.45;
		-webkit-font-smoothing: antialiased;
	}
	/* subtle scanline texture — flat, no curvature */
	:global(body)::before {
		content: "";
		position: fixed;
		inset: 0;
		z-index: 0;
		pointer-events: none;
		background: repeating-linear-gradient(
			0deg,
			rgba(0, 0, 0, 0.16) 0,
			rgba(0, 0, 0, 0.16) 1px,
			transparent 1px,
			transparent 3px
		);
	}

	main {
		position: relative;
		z-index: 1;
		max-width: 64rem;
		margin-inline: auto;
		padding: clamp(1rem, 3vw, 2rem) 1.1rem 3rem;
	}

	.dim {
		color: #2f8f52;
	}
	.sm {
		font-size: 0.82rem;
	}

	.prompt {
		color: #b9ffcf;
		font-size: clamp(0.9rem, 2.4vw, 1.05rem);
		word-break: break-word;
	}
	.cur {
		color: #4ee87a;
		animation: blink 1.1s steps(1) infinite;
	}
	@keyframes blink {
		50% {
			opacity: 0;
		}
	}
	.tag {
		color: #3a9d5f;
		margin: 0.35rem 0 1.4rem;
		max-width: 70ch;
	}
	.load {
		color: #4ee87a;
	}

	/* verdict — one line, no box */
	.verdict {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		font-size: 1.05rem;
		flex-wrap: wrap;
	}
	.dot {
		width: 0.6rem;
		height: 0.6rem;
		border-radius: 50%;
		background: #4ee87a;
		box-shadow: 0 0 8px #4ee87a;
	}
	.verdict.minor .dot {
		background: #ffcf5a;
		box-shadow: 0 0 8px #ffcf5a;
	}
	.verdict.contradictions .dot {
		background: #ff5f56;
		box-shadow: 0 0 8px #ff5f56;
	}
	.vt {
		color: #b9ffcf;
		letter-spacing: 0.04em;
	}
	.verdict.contradictions .vt {
		color: #ff8079;
	}

	.cx {
		list-style: none;
		padding: 0;
		margin: 0.6rem 0 0;
		display: grid;
		gap: 0.25rem;
	}
	.cx li {
		color: #cfeeda;
		padding-left: 0.2rem;
	}
	.sev {
		display: inline-block;
		font-size: 0.64rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		padding: 0 0.3rem;
		margin-right: 0.45rem;
		border: 1px solid currentColor;
	}
	.sev-high .sev {
		color: #ff5f56;
	}
	.sev-medium .sev {
		color: #ffcf5a;
	}
	.sev-info .sev {
		color: #2f8f52;
	}
	.cx .ev {
		display: block;
		color: #2f8f52;
		font-size: 0.78rem;
		padding-left: 2.6rem;
		word-break: break-all;
	}

	.rule {
		height: 1px;
		background: #123a24;
		margin: 1.4rem 0;
	}

	/* linkability */
	.lk-top {
		display: flex;
		align-items: baseline;
		gap: 0.8rem;
		flex-wrap: wrap;
	}
	.hash {
		font-size: clamp(1.5rem, 5vw, 2.2rem);
		color: #b9ffcf;
		letter-spacing: 0.06em;
		text-shadow: 0 0 10px rgba(78, 232, 122, 0.35);
	}
	button {
		font: inherit;
		font-size: 0.82rem;
		color: #b9ffcf;
		background: rgba(78, 232, 122, 0.08);
		border: 1px solid #1f6e3f;
		padding: 0.35rem 0.7rem;
		cursor: pointer;
		transition: background 0.15s cubic-bezier(0.2, 0, 0, 1);
	}
	button:hover {
		background: rgba(78, 232, 122, 0.18);
	}
	button:focus-visible {
		outline: 2px solid #4ee87a;
		outline-offset: 2px;
	}
	.link .sm {
		margin: 0.5rem 0 0;
		max-width: 72ch;
	}

	.banner {
		margin: 0 0 1.2rem;
		padding: 0.5rem 0;
		color: #ff8079;
		border-block: 1px solid #4a1f1c;
	}
	.banner.differ {
		color: #4ee87a;
		border-block-color: #123a24;
	}
	.banner .dim {
		display: block;
		font-size: 0.8rem;
	}

	.entropy {
		margin: 1.4rem 0;
		color: #6cc48a;
	}
	.ebig {
		font-size: clamp(1.6rem, 5vw, 2.2rem);
		color: #b9ffcf;
		text-shadow: 0 0 10px rgba(78, 232, 122, 0.35);
	}

	/* sections — hairline header, flat rows, no boxes */
	section {
		margin-top: 1.5rem;
	}
	h3 {
		font-size: 0.68rem;
		color: #2f8f52;
		text-transform: uppercase;
		letter-spacing: 0.16em;
		margin: 0 0 0.35rem;
		border-bottom: 1px solid #123a24;
		padding-bottom: 0.3rem;
	}
	.row {
		display: grid;
		grid-template-columns: 0.7rem minmax(7rem, 10rem) minmax(0, 1fr) auto auto minmax(4rem, 9rem);
		align-items: baseline;
		gap: 0.6rem;
		padding: 0.18rem 0.2rem;
	}
	.row:hover {
		background: rgba(78, 232, 122, 0.05);
	}
	.g {
		width: 0.45rem;
		height: 0.45rem;
		border-radius: 50%;
		align-self: center;
		background: #1f6e3f;
	}
	.q-dangerous .g {
		background: #ff5f56;
		box-shadow: 0 0 6px rgba(255, 95, 86, 0.7);
	}
	.q-linking .g {
		background: #4ee87a;
	}
	.q-randomized .g {
		background: #58a6ff;
	}
	.q-standardized .g {
		background: #7dffb0;
		box-shadow: 0 0 6px rgba(125, 255, 176, 0.5);
	}
	.q-volatile .g {
		background: #2f8f52;
	}
	.q-common .g {
		background: #1f4a30;
	}
	.lab {
		color: #6cc48a;
	}
	.val {
		color: #cfeeda;
		word-break: break-word;
	}
	.bars {
		color: #4ee87a;
		letter-spacing: -1px;
		font-size: 0.8rem;
		white-space: nowrap;
	}
	.rt {
		font-size: 0.6rem;
		letter-spacing: 0.05em;
		padding: 0 0.25rem;
		border: 1px solid;
		white-space: nowrap;
	}
	.r-stable {
		color: #4ee87a;
		border-color: #1f6e3f;
	}
	.r-randomized {
		color: #58a6ff;
		border-color: #1f4a6e;
	}
	.r-standardized {
		color: #7dffb0;
		border-color: #1f6e4f;
	}
	.r-volatile {
		color: #2f8f52;
		border-color: #123a24;
	}
	.dev {
		color: #2f8f52;
		font-size: 0.8rem;
		text-align: right;
		word-break: break-word;
	}
	.srv {
		grid-template-columns: minmax(7rem, 11rem) minmax(0, 1fr) auto;
	}

	footer {
		margin-top: 2.2rem;
		border-top: 1px solid #123a24;
		padding-top: 0.7rem;
		color: #1f6e3f;
		font-size: 0.8rem;
	}

	@media (max-width: 40rem) {
		.row {
			grid-template-columns: 0.7rem 1fr auto;
			grid-template-areas: "g lab val" ". val val" ". bars rt" ". dev dev";
		}
		.row .val {
			grid-column: 2 / 4;
		}
		.dev {
			text-align: left;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.cur {
			animation: none;
		}
	}
</style>
