<script>
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
  const isInteractive = data.kind === 'interactive';
  let frameEl = $state(null);
  let frameH = $state(isInteractive ? 'calc(100vh - 52px)' : 'calc(100vh - 140px)');   // pre-load fallback; fit() overrides for html
  let ro;
  function fit() {
    try {
      const d = frameEl?.contentDocument;
      if (!d) return;
      const h = Math.max(
        d.documentElement?.scrollHeight || 0,
        d.body?.scrollHeight || 0
      );
      if (h > 0) frameH = h + 'px';
    } catch { /* if anything blocks the read, keep the fallback min-height */ }
  }
  function onFrameLoad() {
    if (isInteractive) return;   // opaque origin: nothing to measure, and no observer to attach
    fit();
    // re-fit on reflow (web-font swap, image decode, our own resizes), browser-agnostic.
    try {
      ro?.disconnect();
      const d = frameEl?.contentDocument;
      if (d?.body && 'ResizeObserver' in window) {
        ro = new ResizeObserver(() => fit());
        ro.observe(d.documentElement);
        ro.observe(d.body);
      }
    } catch { /* observer optional */ }
  }
  $effect(() => () => ro?.disconnect());   // cleanup on unmount
  // slug is DB-validated (lowercase alnum + dashes) but encode defensively so a future
  // looser slug can't smuggle ?/# into the iframe/raw URL.
  const rawUrl = $derived(`/gallery/${encodeURIComponent(data.slug)}/raw`);
</script>

<svelte:head><title>{data.title} · gallery</title></svelte:head>

{#if data.kind === 'html' || isInteractive}
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
      {#if isInteractive}<span class="ht-badge mono" title="Runs in a sandboxed frame (no network, no cookies)">interactive</span>{/if}
      <a class="raw-link mono" href={rawUrl} target="_blank" rel="noopener noreferrer">open full ↗</a>
    </header>
    <iframe
      bind:this={frameEl}
      onload={onFrameLoad}
      title={data.title}
      src={rawUrl}
      sandbox={isInteractive ? 'allow-scripts allow-downloads' : 'allow-same-origin'}
      referrerpolicy="no-referrer"
      style="height:{frameH}"
    ></iframe>
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
  .back { display: inline-block; color: var(--text-3); text-decoration: none; font-size: 12px; margin-bottom: 10px; }
  .back:hover { color: var(--accent-b); }

  /* HTML artifacts get a near-full-bleed shell so a standalone page reads naturally.
     The iframe is sized to its content (no inner scroll) and the whole page scrolls. */
  .html-shell { display: flex; flex-direction: column; min-height: 100%; }
  .html-head {
    display: flex; align-items: center; gap: 14px; padding: 12px 18px;
    border-bottom: 1px solid var(--border-sub); background: var(--surface-1); flex: none;
    position: sticky; top: 0; z-index: 1;
  }
  .html-head .back { margin-bottom: 0; }
  .ht-title { font-size: 13px; font-weight: 600; color: var(--text-1); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .raw-link { font-size: 12px; color: var(--text-3); text-decoration: none; flex: none; }
  .raw-link:hover { color: var(--accent-b); }
  .ht-badge {
    flex: none; font-size: 10.5px; letter-spacing: .04em; text-transform: uppercase;
    color: var(--accent-b); border: 1px solid var(--border-sub); border-radius: 999px;
    padding: 1px 8px; cursor: default;
  }
  iframe { width: 100%; border: 0; background: #fff; display: block; }
  @media (max-width: 640px) { .html-head { padding: 10px 14px; gap: 10px; } }
</style>
