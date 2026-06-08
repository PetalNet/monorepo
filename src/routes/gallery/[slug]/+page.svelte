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
  let frameEl = $state(null);
  let frameH = $state('calc(100vh - 140px)');   // pre-load fallback; fit() overrides on load
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

{#if data.kind === 'html'}
  <!-- standalone HTML document: rendered in a locked-down sandbox.
       sandbox="allow-same-origin" (NOT allow-scripts) => the doc runs NO scripts, no
       forms, no popups, no top-nav; it can't read the SSO cookie, call the API, or
       beacon out (CSP default-src 'none', img/font data: only). allow-same-origin is
       present ONLY so the parent can measure scrollHeight to auto-size the frame — it's
       safe alone (the cookie/DOM risk is the allow-same-origin + allow-scripts COMBO,
       which we never grant). referrerpolicy keeps the SSO cookie context out. -->
  <div class="html-shell">
    <header class="html-head">
      <a class="back mono" href="/gallery">&larr; gallery</a>
      <span class="ht-title">{data.title}</span>
      <a class="raw-link mono" href={rawUrl} target="_blank" rel="noopener noreferrer">open full ↗</a>
    </header>
    <iframe
      bind:this={frameEl}
      onload={onFrameLoad}
      title={data.title}
      src={rawUrl}
      sandbox="allow-same-origin"
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
  iframe { width: 100%; border: 0; background: #fff; display: block; }
  @media (max-width: 640px) { .html-head { padding: 10px 14px; gap: 10px; } }
</style>
