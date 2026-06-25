<script>
  import { enhance } from '$app/forms';
  let { data, form } = $props();

  // origin for building the absolute share URL shown to the user (client-side; falls back to the prod host).
  const origin = $derived(
    (typeof window !== 'undefined' && window.location?.origin) || 'https://tasks.example.com'
  );
  // The freshly-minted link (token shown ONCE — only present right after a createShare action).
  const newShareUrl = $derived(form?.shareCreated && form?.token ? `${origin}/s/${form.token}` : '');
  let sharePanelOpen = $state(false);
  let copied = $state(false);
  async function copyLink() {
    try { await navigator.clipboard.writeText(newShareUrl); copied = true; setTimeout(() => (copied = false), 1500); } catch {}
  }
  const fmtExp = (e) => (e ? `expires ${e} UTC` : 'no expiry');
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

{#snippet sharePanel()}
  <details class="share" bind:open={sharePanelOpen}>
    <summary class="mono">Share link</summary>
    <div class="share-body">
      <p class="share-note">
        Create a secret link that lets someone with <strong>no account</strong> view ONLY this page —
        nothing else behind the login. Anyone with the link can open it until you revoke or it expires.
      </p>

      {#if newShareUrl}
        <div class="share-new">
          <p class="mono lbl">New link (copy it now — it's shown only once):</p>
          <div class="share-row">
            <input class="mono link" readonly value={newShareUrl} onfocus={(e) => e.target.select()} />
            <button type="button" class="copy" onclick={copyLink}>{copied ? 'copied' : 'copy'}</button>
          </div>
          {#if form?.expires_at}<p class="mono sub">expires {form.expires_at} UTC</p>{/if}
        </div>
      {/if}
      {#if form?.shareError}<p class="share-err">{form.shareError}</p>{/if}

      <form method="POST" action="?/createShare" use:enhance class="share-create">
        <input name="label" placeholder="label (optional, e.g. 'client demo')" maxlength="200" />
        <label class="exp mono">expires <input type="datetime-local" name="expires_at" /></label>
        <button type="submit">Create link</button>
      </form>

      {#if data.shares?.length}
        <ul class="share-list">
          {#each data.shares as s (s.id)}
            <li class="share-item {s.active ? 'on' : 'off'}">
              <span class="si-state mono">{s.revoked ? 'revoked' : s.active ? 'active' : 'expired'}</span>
              <span class="si-meta">
                {#if s.label}<strong>{s.label}</strong> · {/if}{fmtExp(s.expires_at)}
                {#if s.created_by}<span class="si-by mono">· {s.created_by}</span>{/if}
              </span>
              {#if !s.revoked}
                <form method="POST" action="?/revokeShare" use:enhance class="si-revoke">
                  <input type="hidden" name="id" value={s.id} />
                  <button type="submit" class="revoke">revoke</button>
                </form>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </details>
{/snippet}

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
    <div class="share-wrap inframe">{@render sharePanel()}</div>
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
      <div class="share-wrap">{@render sharePanel()}</div>
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

  /* ── share-link panel ── */
  .share-wrap { margin: 10px 0 0; }
  .share-wrap.inframe { padding: 8px 18px; border-bottom: 1px solid var(--border-sub); background: var(--surface-1); }
  .share { font-size: 13px; }
  .share > summary { cursor: pointer; color: var(--text-3); font-size: 12px; width: fit-content; }
  .share > summary:hover { color: var(--accent-b); }
  .share-body { margin-top: 10px; max-width: 640px; }
  .share-note { color: var(--text-3); font-size: 12.5px; margin: 0 0 10px; }
  .share-create { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
  .share-create input[name="label"] { flex: 1; min-width: 180px; padding: 5px 8px; }
  .share-create .exp { display: flex; align-items: center; gap: 6px; color: var(--text-3); font-size: 11px; }
  .share-create button, .copy { padding: 5px 12px; cursor: pointer; }
  .share-new { background: var(--surface-1); border: 1px solid var(--border-sub); border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; }
  .share-new .lbl { font-size: 11px; color: var(--text-3); margin: 0 0 6px; }
  .share-row { display: flex; gap: 6px; }
  .share-row .link { flex: 1; padding: 5px 8px; font-size: 12px; }
  .share-new .sub { font-size: 11px; color: var(--text-3); margin: 6px 0 0; }
  .share-err { color: #d33; font-size: 12px; margin: 0 0 10px; }
  .share-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
  .share-item { display: flex; align-items: center; gap: 10px; font-size: 12px; padding: 5px 0; border-top: 1px solid var(--border-sub); }
  .si-state { font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--border-sub); flex: none; }
  .share-item.on .si-state { color: var(--accent-b); }
  .share-item.off .si-state { color: var(--text-3); opacity: .7; }
  .si-meta { flex: 1; min-width: 0; color: var(--text-2); }
  .si-by { color: var(--text-3); }
  .si-revoke { flex: none; }
  .revoke { font-size: 11px; padding: 3px 9px; cursor: pointer; }
</style>
