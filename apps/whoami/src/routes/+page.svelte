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
	import { fetchTrace } from "$lib/trace";
	import { detectExtensions, type ExtFinding } from "$lib/extensions";
	import {
		readCarriedRef,
		buildJumpUrl,
		compareHashes,
		type CarriedRef,
		type LinkResult,
	} from "$lib/linkability";
	import { mountCrt } from "$lib/crt";
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

	let canvas = $state<HTMLCanvasElement | null>(null);

	// derive a sibling subdomain for the cross-context demo, if one is configured
	const SIBLINGS: Record<string, string> = {
		"fingerprint.petalcat.dev": "fingerprint-b.petalcat.dev",
		"fingerprint-b.petalcat.dev": "fingerprint.petalcat.dev",
	};
	let siblingHost = $state<string | undefined>(undefined);

	$effect(() => {
		let alive = true;
		carried = readCarriedRef();
		siblingHost =
			typeof window !== "undefined" ? SIBLINGS[window.location.host] : undefined;

		(async () => {
			const [sigs, tr, ext] = await Promise.all([
				collectSignals(),
				fetchTrace(),
				detectExtensions(),
			]);
			if (!alive) return;
			signals = sigs;
			hash = linkabilityHash(sigs);
			trace = tr;
			extFindings = ext.findings;
			extRan = ext.ran;

			const n = navigator;
			contradictions = checkConsistency(data.server, tr, {
				userAgent: n.userAgent,
				language: n.language,
				languages: [...(n.languages || [])],
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
			alive = false;
		};
	});

	// mount the CRT field once the canvas exists
	$effect(() => {
		if (!canvas) return;
		const handle = mountCrt(canvas, [1.0, 0.71, 0.26]); // amber phosphor
		return () => handle.destroy();
	});

	const grouped = $derived.by(() => {
		const map = new Map<SignalCategory, Signal[]>();
		for (const s of signals) {
			const arr = map.get(s.category) ?? [];
			arr.push(s);
			map.set(s.category, arr);
		}
		return [...map.entries()];
	});

	// cumulative entropy — shown WITH the caveat that signals correlate, so the true
	// joint entropy is well below this sum. We never present the sum as a hard bit count.
	const entropySum = $derived(
		Math.round(signals.reduce((acc, s) => acc + (s.reproducibility === "stable" ? s.entropy : 0), 0)),
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
	const QUAD_LABEL: Record<Quad, string> = {
		dangerous: "identifying + stable",
		linking: "mild + stable",
		randomized: "randomized",
		standardized: "standardized",
		volatile: "volatile",
		common: "in the crowd",
	};

	function bars(entropy: number): string {
		const n = entropy >= 7 ? 4 : entropy >= 4 ? 3 : entropy >= 2 ? 2 : entropy >= 1 ? 1 : 0;
		return "▮".repeat(n) + "▯".repeat(4 - n);
	}

	function reproTag(r: Repro): string {
		return r === "stable" ? "STABLE" : r === "randomized" ? "RANDOM" : r === "standardized" ? "STANDARD" : "VOLATILE";
	}

	const VERDICT_TEXT: Record<Verdict, string> = {
		coherent: "COHERENT — every surface agrees",
		minor: "MINOR MISMATCHES",
		contradictions: "CONTRADICTIONS FOUND",
	};

	async function copyUrl() {
		try {
			await navigator.clipboard.writeText(buildJumpUrl(hash));
			copied = true;
			setTimeout(() => (copied = false), 1800);
		} catch {
			/* clipboard blocked; ignore */
		}
	}

	function jumpSibling() {
		if (siblingHost) window.location.href = buildJumpUrl(hash, siblingHost);
	}
</script>

<canvas bind:this={canvas} class="crt" aria-hidden="true"></canvas>

<main>
	<header>
		<div class="prompt"><span class="user">visitor</span><span class="at">@</span><span class="host">whoami</span><span class="sep">:~$</span> <span class="cmd">cat /proc/self/fingerprint</span><span class="cursor" aria-hidden="true">█</span></div>
		<p class="lede">
			A tracker reads these signals off you silently and asks how unique you are. This reads
			them back out loud — and answers a better question: not "are you unique," but
			<em>can they follow you</em>. Nothing leaves your browser. Nothing is stored.
		</p>
	</header>

	{#if carried && linkResult}
		<section class="link-result {linkResult}">
			<div class="lr-head">
				{#if linkResult === "match"}
					◉ LINKABLE — two contexts, one fingerprint
				{:else}
					◎ NOT LINKED — the fingerprint changed across contexts
				{/if}
			</div>
			<p>
				This context independently computed <code>{hash}</code>. You carried
				<code>{carried.hash}</code>
				{#if carried.fromHost}from <code>{carried.fromHost}</code>{/if}.
				{#if linkResult === "match"}
					They're identical — derived separately, same result — so whatever you changed
					(incognito, a container, a VPN) did <strong>not</strong> break the link. A site on
					both sides would recognise you as the same person.
				{:else}
					They differ, so something (farbling, RFP per-site randomisation, or a genuinely
					different device) broke the cross-context link here.
				{/if}
			</p>
			{#if carried.fromHost && !carried.crossContext}
				<p class="disclaimer">
					Same host — this is a within-context re-check (a refresh, incognito, or container
					on the same origin), not a cross-site test.
				</p>
			{/if}
		</section>
	{/if}

	{#if !ready}
		<p class="loading">reading signals<span class="cursor" aria-hidden="true">▁</span></p>
	{:else}
		<!-- THE VERDICT — the answer, first -->
		<section class="verdict {verdict}">
			<div class="v-line">
				<span class="v-glyph" aria-hidden="true"></span>
				<span class="v-text">{VERDICT_TEXT[verdict]}</span>
			</div>
			{#if contradictions.length === 0}
				<p class="v-body">
					No cross-surface contradictions. Your HTTP headers, the network edge, and your JS
					environment tell one consistent story — which is what a real browser looks like. A
					uniqueness score would flag you; a <em>consistency</em> check clears you. That's the
					difference between "are you unusual" and "are you lying," and only the second is
					evidence.
				</p>
			{:else}
				<p class="v-body">
					A visitor can be dead-average on every single value and still get caught here: a
					coherent real machine cannot emit contradictory signals. These surfaces disagree.
				</p>
				<ul class="contradictions">
					{#each contradictions as c (c.id)}
						<li class="c {c.severity}">
							<div class="c-title"><span class="c-sev">{c.severity}</span> {c.title}</div>
							<p class="c-detail">{c.detail}</p>
							<div class="c-evidence">
								{#each c.evidence as e (e.label)}
									<span class="ev"><span class="ev-label">{e.label}</span> {e.value}</span>
								{/each}
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<!-- LINKABILITY -->
		<section class="panel">
			<h2>can they follow you</h2>
			<div class="hashrow">
				<span class="hlabel">your stable fingerprint</span>
				<code class="bighash">{hash}</code>
			</div>
			<p class="panel-note">
				A digest of only your <em>stable, identifying</em> signals — the ones that re-derive
				from your machine and survive a cache clear. Randomised and volatile signals are left
				out on purpose: they can't link you, so folding them in would overstate the risk.
			</p>
			<div class="actions">
				<button onclick={copyUrl}>{copied ? "copied ✓" : "copy my compare-link"}</button>
				{#if siblingHost}
					<button onclick={jumpSibling}>test against {siblingHost}</button>
				{/if}
			</div>
			<p class="panel-note dim">
				Open the copied link in an incognito window, a fresh container, or with your VPN on. If
				the hash matches, that measure didn't stop cross-visit tracking — a VPN, for instance,
				changes your IP but not your canvas, so the fingerprint stays put.
			</p>
			{#if siblingHost}
				<p class="disclaimer">
					The sibling is a subdomain — the <strong>same site</strong> (eTLD+1), so cookies and
					storage aren't actually partitioned; a real tracker wouldn't need your fingerprint
					here, it'd just set a cookie. We manually isolate (no cookies, no shared storage, hash
					only) so this test measures purely the fingerprint channel. A true cross-<em>site</em>
					test needs a second registrable domain.
				</p>
			{/if}
		</section>

		<!-- ENTROPY, honestly -->
		<section class="panel">
			<h2>how much you leak</h2>
			<div class="entropy">
				<span class="ebig">~{entropySum}</span><span class="eunit">bits of stable entropy</span>
			</div>
			<p class="panel-note">
				This is a <em>sum</em>, and the sum lies high: these signals are heavily correlated
				(canvas ↔ fonts ↔ GPU ↔ OS all move together), so the true joint entropy — how much you
				actually narrow down to — is well below this. Roughly, ~10 bits ≈ 1-in-a-million, ~20 ≈
				1-in-a-thousand, ~30 ≈ globally unique — but read it as a pile that builds up, not a
				scoreboard. The buildup is the point; no single line is the leak.
			</p>
		</section>

		<!-- THE INVENTORY -->
		{#each grouped as [category, items] (category)}
			<section class="readout">
				<h3>{CATEGORY_LABELS[category]}</h3>
				<div class="rows">
					{#each items as sig (sig.id)}
						{@const q = quadrant(sig)}
						<div class="row q-{q}">
							<span class="glyph" aria-hidden="true" title={QUAD_LABEL[q]}></span>
							<span class="label">{sig.label}</span>
							<span class="value">{sig.value}</span>
							<span class="meta">
								<span class="ebars" title="{sig.entropy} bits (relative)">{bars(sig.entropy)}</span>
								<span class="rtag r-{sig.reproducibility}" title={REPRO_LABELS[sig.reproducibility]}>{reproTag(sig.reproducibility)}</span>
							</span>
							<span class="deviation">you: {sig.value} · crowd: {sig.typical}</span>
							<span class="note">{sig.note}</span>
						</div>
					{/each}
				</div>
			</section>
		{/each}

		<!-- SERVER SURFACE -->
		<section class="panel">
			<h2>what the server saw</h2>
			<div class="srows">
				<div class="srow"><span class="sk">your IP</span><span class="sv">{data.server.ip ?? "(hidden)"} <span class="dim">— your own address, shown back to you; not stored</span></span></div>
				{#if trace}
					<div class="srow"><span class="sk">WARP</span><span class="sv">{trace.warp ?? "?"}{trace.warp === "on" || trace.warp === "plus" ? " — you're on Cloudflare WARP; the edge IP above is Cloudflare's, not your real location" : ""}</span></div>
					<div class="srow"><span class="sk">Zero Trust gateway</span><span class="sv">{trace.gateway ?? "?"}</span></div>
					<div class="srow"><span class="sk">edge sees you in</span><span class="sv">{trace.loc ?? "?"}</span></div>
					<div class="srow"><span class="sk">TLS</span><span class="sv">{trace.tls ?? "?"}</span></div>
					<div class="srow"><span class="sk">CF datacenter</span><span class="sv">{trace.colo ?? "?"}</span></div>
				{/if}
				<div class="srow"><span class="sk">Accept-Language</span><span class="sv">{data.server.acceptLanguage ?? "(none)"}</span></div>
				<div class="srow"><span class="sk">Sec-CH-UA</span><span class="sv">{data.server.secChUa ?? "(absent — Firefox/Safari don't send it)"}</span></div>
				<div class="srow"><span class="sk">Accept-Encoding</span><span class="sv">{data.server.acceptEncoding ?? "(none)"}</span></div>
			</div>
			<p class="panel-note dim">
				The richest server-only signals — the TLS JA3/JA4 fingerprint and raw HTTP/2
				header order — aren't here, and that's honest: this app sits behind a Cloudflare tunnel,
				which terminates TLS and normalises headers, so the ClientHello never reaches the origin.
				They'd need CF Enterprise. We show what actually survives.
			</p>
		</section>

		<!-- EXTENSIONS -->
		<section class="panel">
			<h2>installed extensions</h2>
			{#if extFindings.length > 0}
				<ul class="ext">
					{#each extFindings as f (f.id)}
						<li>
							<div class="ext-name">▸ {f.name} <span class="ext-conf">{f.confidence}</span></div>
							<p class="ext-detail">{f.detail} <span class="dim">({f.method})</span></p>
						</li>
					{/each}
				</ul>
			{:else if extRan}
				<p class="panel-note">
					Nothing detected — but read that carefully. A clean result means <em>either</em> no
					detectable extension <em>or</em> a defense is active (some tools route
					getComputedStyle through a Shadow DOM so injected styles read clean). Absence here is
					not proof of absence.
				</p>
			{/if}
			<p class="panel-note dim">
				Detection is by CSS style-injection: we plant a decoy an extension's stylesheet would
				target, plus an identical baseline that it wouldn't, and diff the computed styles — the
				baseline is the control that makes "was a style applied" decidable. This ships a small
				hand-seeded bait list (ad-blockers, page-wide theming); real breadth needs a maintained,
				versioned trigger corpus. The method works on Firefox; the selectors rot.
			</p>
		</section>

		<footer>
			<p>read-only · no storage · no logs · no network calls beyond this page and its own edge trace</p>
		</footer>
	{/if}
</main>

<style>
	:global(html) {
		background: #0a0705;
	}
	:global(body) {
		margin: 0;
		background: #0a0705;
		color: #ffb642;
		font-family: ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace;
		font-size: 15px;
		line-height: 1.5;
		-webkit-font-smoothing: antialiased;
	}

	.crt {
		position: fixed;
		inset: 0;
		width: 100vw;
		height: 100vh;
		z-index: 0;
		display: block;
	}

	main {
		position: relative;
		z-index: 1;
		max-width: 60rem;
		margin-inline: auto;
		padding: clamp(1.25rem, 4vw, 3rem) 1.25rem 5rem;
	}

	/* faint scanline overlay tuned to the shader, plus a readability scrim */
	main::before {
		content: "";
		position: fixed;
		inset: 0;
		z-index: -1;
		background:
			radial-gradient(120% 90% at 50% 30%, rgba(10, 7, 5, 0.35), rgba(10, 7, 5, 0.82) 75%),
			repeating-linear-gradient(0deg, rgba(0, 0, 0, 0.22) 0, rgba(0, 0, 0, 0.22) 1px, transparent 1px, transparent 3px);
		pointer-events: none;
	}

	/* header / prompt */
	.prompt {
		font-size: clamp(0.95rem, 2.6vw, 1.25rem);
		color: #ffd9a0;
		text-shadow: 0 0 6px rgba(255, 160, 60, 0.45);
		word-break: break-word;
	}
	.user { color: #ffb642; }
	.at, .sep { color: #b87a2e; }
	.host { color: #ff9f4a; }
	.cmd { color: #ffe7c4; }
	.cursor {
		color: #ffd9a0;
		animation: blink 1.1s steps(1) infinite;
	}
	@keyframes blink { 50% { opacity: 0; } }
	.lede {
		max-width: 54ch;
		color: #d69a54;
		margin: 1rem 0 2.25rem;
		line-height: 1.6;
	}
	.lede em { color: #ffd9a0; font-style: normal; }

	.loading { color: #ffb642; }

	/* verdict — the lede answer */
	.verdict {
		border: 1px solid #3a2a12;
		background: rgba(20, 13, 6, 0.55);
		padding: 1.1rem 1.25rem;
		margin-bottom: 2.25rem;
	}
	.verdict.contradictions { border-color: #5a241f; background: rgba(30, 12, 10, 0.6); }
	.verdict.minor { border-color: #5a4a1c; }
	.v-line { display: flex; align-items: center; gap: 0.7rem; font-size: 1.15rem; letter-spacing: 0.02em; }
	.v-glyph { width: 0.7rem; height: 0.7rem; border-radius: 50%; background: #7ee0a8; box-shadow: 0 0 10px #7ee0a8; }
	.verdict.minor .v-glyph { background: #ffc95a; box-shadow: 0 0 10px #ffc95a; }
	.verdict.contradictions .v-glyph { background: #ff6b5c; box-shadow: 0 0 10px #ff6b5c; }
	.v-text { color: #ffe7c4; }
	.verdict.contradictions .v-text { color: #ff8f83; }
	.v-body { color: #d69a54; max-width: 60ch; margin: 0.8rem 0 0; }
	.v-body em { color: #ffd9a0; font-style: normal; }

	.contradictions { list-style: none; padding: 0; margin: 1rem 0 0; display: grid; gap: 0.8rem; }
	.c { border: 1px solid #3a2a12; background: rgba(0, 0, 0, 0.25); padding: 0.7rem 0.85rem; }
	.c.high { border-color: #5a241f; }
	.c.medium { border-color: #5a4a1c; }
	.c-title { color: #ffe7c4; font-weight: 600; }
	.c-sev {
		font-size: 0.7rem; letter-spacing: 0.08em; text-transform: uppercase;
		border: 1px solid currentColor; padding: 0.05rem 0.35rem; margin-right: 0.4rem; vertical-align: middle;
	}
	.c.high .c-sev { color: #ff6b5c; }
	.c.medium .c-sev { color: #ffc95a; }
	.c.info .c-sev { color: #b87a2e; }
	.c-detail { color: #c79350; margin: 0.4rem 0; max-width: 62ch; }
	.c-evidence { display: flex; flex-wrap: wrap; gap: 0.5rem 1.2rem; }
	.ev { color: #ffd9a0; font-size: 0.88rem; word-break: break-all; }
	.ev-label { color: #8f6428; text-transform: uppercase; font-size: 0.68rem; letter-spacing: 0.06em; margin-right: 0.3rem; }

	/* panels */
	.panel { margin-bottom: 2.25rem; }
	h2 {
		font-size: 0.95rem; color: #ff9f4a; margin: 0 0 0.75rem; font-weight: 700;
		border-bottom: 1px solid #2c2010; padding-bottom: 0.45rem;
	}
	h2::before { content: "> "; color: #6f4e1f; }
	.panel-note { color: #c79350; max-width: 64ch; margin: 0.7rem 0 0; line-height: 1.6; }
	.panel-note em { color: #ffd9a0; font-style: normal; }
	.panel-note.dim { color: #916630; font-size: 0.9rem; }
	.disclaimer {
		color: #d69a54; font-size: 0.9rem; margin: 0.8rem 0 0; padding: 0.6rem 0.75rem;
		border: 1px dashed #5a4a1c; background: rgba(255, 200, 80, 0.04); max-width: 64ch;
	}
	.disclaimer strong, .disclaimer em { color: #ffd9a0; font-style: normal; }
	.dim { color: #916630; }

	/* linkability */
	.hashrow { display: flex; align-items: baseline; gap: 0.9rem; flex-wrap: wrap; }
	.hlabel { color: #b87a2e; text-transform: uppercase; font-size: 0.72rem; letter-spacing: 0.08em; }
	.bighash {
		font-size: clamp(1.6rem, 6vw, 2.6rem); color: #ffd9a0; letter-spacing: 0.06em;
		text-shadow: 0 0 12px rgba(255, 160, 60, 0.4);
	}
	.actions { display: flex; gap: 0.7rem; flex-wrap: wrap; margin: 1.1rem 0 0.3rem; }
	button {
		font: inherit; font-size: 0.9rem; color: #ffd9a0; background: rgba(255, 170, 66, 0.08);
		border: 1px solid #5a3f16; padding: 0.5rem 0.9rem; cursor: pointer;
		transition: background 0.18s cubic-bezier(0.2, 0, 0, 1), border-color 0.18s;
	}
	button:hover { background: rgba(255, 170, 66, 0.16); border-color: #8a6222; }
	button:focus-visible { outline: 2px solid #ffb642; outline-offset: 2px; }

	/* link result banner */
	.link-result { border: 1px solid; padding: 1rem 1.25rem; margin-bottom: 2rem; }
	.link-result.match { border-color: #5a241f; background: rgba(30, 12, 10, 0.55); }
	.link-result.differ { border-color: #24503a; background: rgba(10, 26, 18, 0.5); }
	.lr-head { font-size: 1.1rem; color: #ffe7c4; }
	.link-result.match .lr-head { color: #ff8f83; }
	.link-result.differ .lr-head { color: #7ee0a8; }
	.link-result p { color: #d69a54; max-width: 64ch; margin: 0.6rem 0 0; }
	.link-result code { color: #ffd9a0; }
	.link-result strong { color: #ffe7c4; }

	.entropy { display: flex; align-items: baseline; gap: 0.6rem; }
	.ebig { font-size: clamp(2rem, 7vw, 3rem); color: #ffd9a0; text-shadow: 0 0 12px rgba(255, 160, 60, 0.4); }
	.eunit { color: #b87a2e; }

	/* readout rows */
	.readout { margin-bottom: 1.6rem; }
	h3 {
		font-size: 0.72rem; color: #8f6428; text-transform: uppercase; letter-spacing: 0.14em;
		margin: 0 0 0.5rem;
	}
	h3::before { content: "── "; color: #4a3616; }
	.rows { display: grid; gap: 0.15rem; }
	.row {
		display: grid;
		grid-template-columns: 0.8rem minmax(9rem, 1fr) minmax(0, 1.4fr) auto;
		grid-template-areas:
			"glyph label value meta"
			". deviation deviation deviation"
			". note note note";
		gap: 0.15rem 0.75rem;
		align-items: baseline;
		padding: 0.5rem 0.5rem;
		border-bottom: 1px solid rgba(60, 42, 18, 0.4);
	}
	.row:hover { background: rgba(255, 170, 66, 0.04); }
	.glyph { grid-area: glyph; width: 0.5rem; height: 0.5rem; border-radius: 50%; align-self: center; background: #6f4e1f; }
	.q-dangerous .glyph { background: #ff6b5c; box-shadow: 0 0 7px rgba(255, 107, 92, 0.7); }
	.q-linking .glyph { background: #ffb642; }
	.q-randomized .glyph { background: #6aa9ff; }
	.q-standardized .glyph { background: #7ee0a8; box-shadow: 0 0 6px rgba(126, 224, 168, 0.5); }
	.q-volatile .glyph { background: #916630; }
	.q-common .glyph { background: #4a6a52; }
	.label { grid-area: label; color: #c79350; }
	.value { grid-area: value; color: #ffe7c4; word-break: break-word; }
	.meta { grid-area: meta; display: flex; gap: 0.6rem; align-items: center; white-space: nowrap; }
	.ebars { color: #ff9f4a; letter-spacing: -1px; font-size: 0.85rem; }
	.rtag { font-size: 0.62rem; letter-spacing: 0.06em; padding: 0.05rem 0.3rem; border: 1px solid; }
	.r-stable { color: #ff9f4a; border-color: #5a3f16; }
	.r-randomized { color: #6aa9ff; border-color: #24405a; }
	.r-standardized { color: #7ee0a8; border-color: #24503a; }
	.r-volatile { color: #916630; border-color: #4a3616; }
	.deviation { grid-area: deviation; color: #8f6428; font-size: 0.82rem; word-break: break-word; }
	.note { grid-area: note; color: #a97e3e; font-size: 0.85rem; line-height: 1.5; max-width: 68ch; }

	/* server rows */
	.srows { display: grid; gap: 0.3rem; }
	.srow { display: grid; grid-template-columns: minmax(9rem, 12rem) 1fr; gap: 0.75rem; padding: 0.35rem 0; border-bottom: 1px solid rgba(60, 42, 18, 0.35); }
	.sk { color: #8f6428; text-transform: uppercase; font-size: 0.72rem; letter-spacing: 0.06em; }
	.sv { color: #ffe7c4; word-break: break-word; }

	/* extensions */
	.ext { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.7rem; }
	.ext-name { color: #ffe7c4; }
	.ext-conf { font-size: 0.68rem; letter-spacing: 0.06em; text-transform: uppercase; color: #ff9f4a; border: 1px solid #5a3f16; padding: 0.05rem 0.35rem; margin-left: 0.3rem; }
	.ext-detail { color: #c79350; margin: 0.3rem 0 0; max-width: 64ch; }

	footer { margin-top: 3rem; border-top: 1px solid #2c2010; padding-top: 1rem; color: #6f4e1f; font-size: 0.82rem; }

	@media (max-width: 34rem) {
		.row { grid-template-columns: 0.8rem 1fr; grid-template-areas: "glyph label" "glyph value" ". meta" ". deviation" ". note"; }
		.meta { flex-wrap: wrap; white-space: normal; }
	}

	@media (prefers-reduced-motion: reduce) {
		.cursor { animation: none; }
	}
</style>
