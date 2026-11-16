<script>
	import { inkLayer } from "$lib/ink.js";
	import { Eraser, Highlighter, PenLine, Trash2, Undo2 } from "@lucide/svelte";
	import { onMount } from "svelte";

	let { data } = $props();
	// For HTML artifacts we size the iframe to its content height so the page scrolls as
	// ONE document (no nested scrollbar, nothing cropped). The iframe is
	// sandbox="allow-same-origin" but NOT allow-scripts: the artifact still runs ZERO
	// scripts (can't read the SSO cookie, call the API, navigate, or submit forms — the
	// CSP + remaining sandbox keep it inert), but because it shares our origin the PARENT
	// can read its scrollHeight and grow the frame to fit. No script ever runs inside the
	// artifact; the measuring is done by us, from the outside. (allow-same-origin is only
	// dangerous COMBINED with allow-scripts — alone it's a static, introspectable doc.)
	// 'interactive' artifacts run their own JS, so they're framed in an OPAQUE origin
	// (sandbox allow-scripts, NOT allow-same-origin) — we therefore CAN'T read their
	// scrollHeight to auto-size. They get a fixed full-viewport frame + the "open full"
	// link for true fullscreen. Only 'html' (script-less, same-origin) gets the fit logic.
	const isInteractive = $derived(data.kind === "interactive");
	let frameEl = $state(null);
	let frameH = $state((() => (isInteractive ? "calc(100vh - 52px)" : "calc(100vh - 140px)"))()); // pre-load fallback; fit() overrides for html
	let ro;
	function fit() {
		try {
			const d = frameEl?.contentDocument;

			if (!d) {
				return;
			}

			const h = Math.max(d.documentElement?.scrollHeight || 0, d.body?.scrollHeight || 0);

			if (h > 0) {
				frameH = h + "px";
			}
		} catch {
			/* if anything blocks the read, keep the fallback min-height */
		}
	}
	function onFrameLoad() {
		if (isInteractive) {
			// opaque origin: nothing to measure. Handshake with the ink bootstrap (?ink=1) instead.
			inkReady = false;
			frameEl?.contentWindow?.postMessage({ ink: "init" }, "*");

			return;
		}

		fit();

		// re-fit on reflow (web-font swap, image decode, our own resizes), browser-agnostic.
		try {
			ro?.disconnect();
			const d = frameEl?.contentDocument;

			if (d?.body && "ResizeObserver" in window) {
				ro = new ResizeObserver(() => fit());
				ro.observe(d.documentElement);
				ro.observe(d.body);
			}
		} catch {
			/* observer optional */
		}
	}
	$effect(() => () => ro?.disconnect()); // cleanup on unmount
	// slug is DB-validated (lowercase alnum + dashes) but encode defensively so a future
	// looser slug can't smuggle ?/# into the iframe/raw URL.
	const rawUrl = $derived(`/gallery/${encodeURIComponent(data.slug)}/raw`);

	// Pencil markup. The ink layer (src/lib/ink.js) lives where the page's coordinates are:
	// inside the interactive iframe (injected via ?ink=1, spoken to by postMessage), or for
	// html artifacts in an overlay laid over the auto-sized iframe here, since that frame
	// scrolls with this page and can't run scripts. Either way strokes come back here and
	// are saved per viewer, debounced.
	const COLORS = [
		["#e5484d", "Red"],
		["#2f6fed", "Blue"],
		["#1f9d55", "Green"],
		["#f76b15", "Orange"],
	];
	let overlayEl = $state(null);
	let layer = null;
	let inkReady = $state(false);
	let marking = $state(false);
	let tool = $state("pen");
	let color = $state(COLORS[0][0]);
	let canUndo = $state(false);
	let strokes = $state.raw((() => data.markup)());
	let saveState = $state("");
	let saveTimer;
	let unsaved = false;
	let saving = Promise.resolve();
	// fixed at creation: a save flushed on unmount must still go to this artifact
	const markupUrl = `/api/markup/${encodeURIComponent((() => data.slug)())}`;

	function send(m) {
		if (isInteractive) {
			frameEl?.contentWindow?.postMessage(m, "*");
		} else {
			layer?.handle(m);
		}
	}
	function onInk(m) {
		if (m.ink === "ready") {
			inkReady = true;
			canUndo = false;
			send({ ink: "set", strokes });
			send({ ink: "tool", tool, color });
			send({ ink: "arm", on: marking });
		} else if (m.ink === "change" && Array.isArray(m.strokes)) {
			strokes = m.strokes;
			canUndo = Boolean(m.canUndo);
			unsaved = true;
			saveState = "saving";
			clearTimeout(saveTimer);
			saveTimer = setTimeout(save, 800);
		}
	}
	function save(final = false) {
		clearTimeout(saveTimer);

		if (!unsaved) {
			return saving;
		}

		unsaved = false;
		const body = JSON.stringify({ strokes });

		saving = saving.then(async () => {
			try {
				const r = await fetch(markupUrl, {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body,
					keepalive: final && body.length < 60_000,
				});

				saveState = r.ok ? "saved" : r.status === 413 ? "too much ink to save" : "save failed";
				unsaved ||= !r.ok;
			} catch {
				saveState = "save failed";
				unsaved = true;
			}
		});

		return saving;
	}
	function toggleMarking() {
		marking = !marking;
		send({ ink: "arm", on: marking });

		if (!marking) {
			save();
		}
	}
	function pick(t, c) {
		tool = t;

		if (c) {
			color = c;
		}

		send({ ink: "tool", tool, color });
	}
	onMount(() => {
		if (!isInteractive && overlayEl) {
			layer = inkLayer(window, { host: overlayEl, emit: onInk });
			onInk({ ink: "ready" });
		}

		const onMessage = (e) => {
			if (isInteractive && e.source === frameEl?.contentWindow && typeof e.data?.ink === "string") {
				onInk(e.data);
			}
		};

		const flush = () => save(true);

		window.addEventListener("message", onMessage);
		window.addEventListener("pagehide", flush);

		return () => {
			window.removeEventListener("message", onMessage);
			window.removeEventListener("pagehide", flush);
			save(true);
		};
	});
</script>

<svelte:head><title>{data.title} · gallery</title></svelte:head>

{#if data.kind === "html" || isInteractive}
	<!-- standalone document rendered in a locked-down sandbox. Two profiles:
       - 'html'        sandbox="allow-same-origin" (NOT allow-scripts) => zero scripts; the
                       same-origin token is present ONLY so the parent can measure scrollHeight
                       to auto-size the frame. Safe alone — the risk is the same-origin+scripts
                       COMBO, never granted here.
       - 'interactive' sandbox="allow-scripts allow-downloads" (NOT allow-same-origin) => its JS
                       runs but in an OPAQUE origin (a confidentiality cage): it can't read the
                       SSO cookie, reach this parent DOM, navigate the top frame, or make scripted
                       background requests. The raw endpoint sends a matching CSP sandbox (+ the
                       full residual-channel rationale), so "open full" is caged identically.
       referrerpolicy keeps the SSO cookie context out either way. -->
	<div class="html-shell">
		<header class="html-head">
			<a class="back mono" href="/gallery">&larr; gallery</a>
			<span class="ht-title">{data.title}</span>
			{#if isInteractive}<span
					class="ht-badge mono"
					title="Runs in a sandboxed frame (no network, no cookies)">interactive</span
				>{/if}
			{#if marking}
				<div class="inkbar" role="toolbar" aria-label="Markup tools">
					{#each COLORS as [c, name] (c)}
						<button
							class="ink-btn swatch"
							class:sel={tool === "pen" && color === c}
							style="--swatch:{c}"
							aria-label="{name} pen"
							aria-pressed={tool === "pen" && color === c}
							title="{name} pen"
							onclick={() => pick("pen", c)}
						></button>
					{/each}
					<button
						class="ink-btn"
						class:sel={tool === "hl"}
						aria-pressed={tool === "hl"}
						aria-label="Highlighter"
						title="Highlighter"
						onclick={() => pick("hl")}><Highlighter size={16} /></button
					>
					<button
						class="ink-btn"
						class:sel={tool === "erase"}
						aria-pressed={tool === "erase"}
						aria-label="Eraser"
						title="Eraser (whole strokes)"
						onclick={() => pick("erase")}><Eraser size={16} /></button
					>
					<span class="ink-sep"></span>
					<button
						class="ink-btn"
						disabled={!canUndo}
						aria-label="Undo"
						title="Undo"
						onclick={() => send({ ink: "undo" })}><Undo2 size={16} /></button
					>
					<button
						class="ink-btn"
						disabled={!strokes.length}
						aria-label="Clear all ink"
						title="Clear all ink"
						onclick={() => send({ ink: "clear" })}><Trash2 size={16} /></button
					>
					<span class="ink-status mono" aria-live="polite">{saveState}</span>
				</div>
			{/if}
			{#if inkReady}
				<button
					class="ink-toggle mono"
					class:on={marking}
					aria-pressed={marking}
					onclick={toggleMarking}
					title={marking ? "Stop marking up" : "Mark up with Apple Pencil or mouse"}
					><PenLine size={14} />{marking ? "done" : "markup"}</button
				>
			{/if}
			<a class="raw-link mono" href={rawUrl} target="_blank" rel="noopener noreferrer"
				>open full ↗</a
			>
		</header>
		<div class="frame-wrap">
			<iframe
				bind:this={frameEl}
				onload={onFrameLoad}
				title={data.title}
				src={isInteractive ? `${rawUrl}?ink=1` : rawUrl}
				sandbox={isInteractive ? "allow-scripts allow-downloads" : "allow-same-origin"}
				referrerpolicy="no-referrer"
				style="height:{frameH}"
			></iframe>
			{#if !isInteractive}<div class="ink-overlay" bind:this={overlayEl}></div>{/if}
		</div>
	</div>
{:else}
	<div class="screen detail">
		<header class="page-head">
			<a class="back mono" href="/gallery">&larr; gallery</a>
			<h1>{data.title}</h1>
			{#if data.description}<p class="ph-sub">{data.description}</p>{/if}
		</header>
		<article class="prose long">{@html data.bodyHtml}</article>
	</div>
{/if}

<style>
	.back {
		display: inline-block;
		color: var(--text-3);
		text-decoration: none;
		font-size: 12px;
		margin-bottom: 10px;
	}
	.back:hover {
		color: var(--accent-b);
	}

	/* HTML artifacts get a near-full-bleed shell so a standalone page reads naturally.
     The iframe is sized to its content (no inner scroll) and the whole page scrolls. */
	.html-shell {
		display: flex;
		flex-direction: column;
		min-height: 100%;
	}
	.html-head {
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 12px 18px;
		border-bottom: 1px solid var(--border-sub);
		background: var(--surface-1);
		flex: none;
		position: sticky;
		top: 0;
		z-index: 1;
	}
	.html-head .back {
		margin-bottom: 0;
	}
	.ht-title {
		font-size: 13px;
		font-weight: 600;
		color: var(--text-1);
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.raw-link {
		font-size: 12px;
		color: var(--text-3);
		text-decoration: none;
		flex: none;
	}
	.raw-link:hover {
		color: var(--accent-b);
	}
	.ht-badge {
		flex: none;
		font-size: 10.5px;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--accent-b);
		border: 1px solid var(--border-sub);
		border-radius: 999px;
		padding: 1px 8px;
		cursor: default;
	}
	iframe {
		width: 100%;
		border: 0;
		background: #fff;
		display: block;
	}
	.frame-wrap {
		position: relative;
	}
	.ink-overlay {
		position: absolute;
		inset: 0;
		pointer-events: none;
	}
	.ink-toggle {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 12px;
		color: var(--text-3);
		background: none;
		border: 1px solid var(--border-sub);
		border-radius: 999px;
		padding: 3px 10px;
		cursor: pointer;
	}
	.ink-toggle:hover,
	.ink-toggle.on {
		color: var(--accent-b);
	}
	.ink-toggle.on {
		border-color: var(--accent-b);
	}
	.inkbar {
		flex: none;
		display: flex;
		align-items: center;
		gap: 2px;
	}
	.ink-btn {
		width: 32px;
		height: 32px;
		display: grid;
		place-items: center;
		border-radius: 8px;
		background: none;
		border: 1px solid transparent;
		color: var(--text-3);
		cursor: pointer;
		padding: 0;
	}
	.ink-btn:hover:not(:disabled) {
		color: var(--text-1);
	}
	.ink-btn.sel {
		border-color: var(--border-sub);
		color: var(--text-1);
		background: var(--surface-2);
	}
	.ink-btn:disabled {
		opacity: 0.35;
		cursor: default;
	}
	.swatch::before {
		content: "";
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: var(--swatch);
	}
	.swatch.sel::before {
		box-shadow:
			0 0 0 2px var(--surface-1),
			0 0 0 3.5px var(--swatch);
	}
	.ink-sep {
		width: 1px;
		height: 18px;
		background: var(--border-sub);
		margin: 0 4px;
	}
	.ink-status {
		font-size: 11px;
		color: var(--text-3);
		min-width: 4.5em;
		padding-left: 4px;
	}
	@media (max-width: 640px) {
		.html-head {
			padding: 10px 14px;
			gap: 10px;
		}
	}
</style>
