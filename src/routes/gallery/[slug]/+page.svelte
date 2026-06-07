<script>
  let { data } = $props();
  // For HTML artifacts we resize the sandboxed iframe to its content height so the page
  // scrolls as one document (no nested scrollbar). The iframe is sandbox="" (NO scripts,
  // NO same-origin), so it can't postMessage its height to us — instead we measure on
  // load via the parent's own access... which the sandbox also blocks cross-origin-style.
  // So we just give it a generous viewport-tall min-height and let it scroll internally
  // on overflow. Simple, safe, browser-agnostic.
  let frameH = $state('calc(100vh - 180px)');
  // slug is DB-validated (lowercase alnum + dashes) but encode defensively so a future
  // looser slug can't smuggle ?/# into the iframe/raw URL.
  const rawUrl = $derived(`/gallery/${encodeURIComponent(data.slug)}/raw`);
</script>

<svelte:head><title>{data.title} · gallery</title></svelte:head>

{#if data.kind === 'html'}
  <!-- standalone HTML document: rendered in a locked-down sandbox.
       sandbox="" => no scripts, no same-origin, no forms, no popups. The doc's own
       <style>/<script> can't escape the frame, touch tasks' DOM/cookies, or call back
       to the origin. referrerpolicy keeps the SSO cookie context out of any sub-request. -->
  <div class="html-shell">
    <header class="html-head">
      <a class="back mono" href="/gallery">&larr; gallery</a>
      <span class="ht-title">{data.title}</span>
      <a class="raw-link mono" href={rawUrl} target="_blank" rel="noopener noreferrer">open full ↗</a>
    </header>
    <iframe
      title={data.title}
      src={rawUrl}
      sandbox=""
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

  /* HTML artifacts get a near-full-bleed shell so a standalone page reads naturally */
  .html-shell { display: flex; flex-direction: column; height: 100%; }
  .html-head {
    display: flex; align-items: center; gap: 14px; padding: 12px 18px;
    border-bottom: 1px solid var(--border-sub); background: var(--surface-1); flex: none;
  }
  .html-head .back { margin-bottom: 0; }
  .ht-title { font-size: 13px; font-weight: 600; color: var(--text-1); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .raw-link { font-size: 12px; color: var(--text-3); text-decoration: none; flex: none; }
  .raw-link:hover { color: var(--accent-b); }
  iframe { width: 100%; border: 0; background: #fff; display: block; }
  @media (max-width: 640px) { .html-head { padding: 10px 14px; gap: 10px; } }
</style>
