<script>
  // Page-anchored collaborative annotations ("stickies"). Long-press (touch) or
  // right-click (desktop) anywhere on the page -> composer -> a note pinned to that
  // DOM element. Renders as a floating pin; click to expand; "ack & remove" deletes.
  // Scoped by page pathname; styles live in app.css (.sticky-* / .sk-* / .composer / .cm-*).
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';

  let comments = $state([]);              // [{id, anchor_selector, anchor_snippet, anchor_offset_x, anchor_offset_y, body, author, created_at}]
  let expandedIds = $state(new Set());
  let composer = $state(null);           // {x, y, anchor_selector, anchor_snippet, anchor_offset_x, anchor_offset_y, body, submitting}
  let positionTick = $state(0);          // bumped on scroll/resize to re-place pins

  let scrollHandler = null;
  let resizeHandler = null;
  let pageLoaded = false;

  const LONG_PRESS_MS = 600;
  const MOVE_CANCEL_PX = 8;
  let pressTimer = null;
  let pressOrigin = null;

  // ── selector + snippet helpers ──────────────────────────────────────────
  function buildSelector(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur.id !== 'app' && cur.tagName !== 'BODY') {
      let part = cur.tagName.toLowerCase();
      if (cur.id) { part += `#${cur.id}`; parts.unshift(part); break; }
      const parent = cur.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }
  function snippetFor(el) {
    const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
    return text.length > 80 ? text.slice(0, 77) + '…' : text;
  }
  function findElement(selector) {
    try { return document.querySelector(selector); } catch { return null; }
  }
  function isOurUI(el) {
    while (el) {
      if (el instanceof HTMLElement && el.dataset.stickyUi === 'true') return true;
      el = el.parentElement;
    }
    return false;
  }

  // ── long-press / right-click detection ──────────────────────────────────
  function skipTarget(target) {
    if (!target || isOurUI(target)) return true;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A';
  }
  function onPointerDown(ev) {
    if (composer || ev.pointerType === 'mouse') return; // mouse uses right-click instead
    const target = ev.target;
    if (skipTarget(target)) return;
    pressOrigin = { x: ev.clientX, y: ev.clientY, target };
    pressTimer = setTimeout(() => {
      if (pressOrigin) openComposerAt(pressOrigin.x, pressOrigin.y, pressOrigin.target);
    }, LONG_PRESS_MS);
  }
  function onPointerMove(ev) {
    if (!pressOrigin || !pressTimer) return;
    const dx = ev.clientX - pressOrigin.x, dy = ev.clientY - pressOrigin.y;
    if (dx * dx + dy * dy > MOVE_CANCEL_PX * MOVE_CANCEL_PX) cancelPress();
  }
  function cancelPress() {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = null; pressOrigin = null;
  }
  function onContextMenu(ev) {
    if (composer) return;
    const target = ev.target;
    if (skipTarget(target)) return;
    ev.preventDefault();
    openComposerAt(ev.clientX, ev.clientY, target);
  }

  // ── composer ────────────────────────────────────────────────────────────
  $effect(() => {
    if (composer) {
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = ''; };
    }
  });
  function openComposerAt(x, y, target) {
    const rect = target.getBoundingClientRect();
    const offX = rect.width > 0 ? Math.max(0, Math.min(1, (x - rect.left) / rect.width)) : 0.5;
    const offY = rect.height > 0 ? Math.max(0, Math.min(1, (y - rect.top) / rect.height)) : 0.5;
    composer = {
      x, y,
      anchor_selector: buildSelector(target),
      anchor_snippet: snippetFor(target),
      anchor_offset_x: offX,
      anchor_offset_y: offY,
      body: '',
      submitting: false
    };
  }
  function closeComposer() { composer = null; }
  async function submitComposer() {
    if (!composer) return;
    const body = composer.body.trim();
    if (!body) return;
    composer.submitting = true;
    try {
      const res = await fetch('/api/annotations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          page_path: $page.url.pathname,
          anchor_selector: composer.anchor_selector,
          anchor_snippet: composer.anchor_snippet,
          anchor_offset_x: composer.anchor_offset_x,
          anchor_offset_y: composer.anchor_offset_y,
          body
        })
      });
      if (!res.ok) { composer.submitting = false; return; }
      closeComposer();
      await loadComments();
    } catch {
      if (composer) composer.submitting = false;
    }
  }

  // ── load + ack ──────────────────────────────────────────────────────────
  async function loadComments() {
    try {
      const res = await fetch(`/api/annotations?page=${encodeURIComponent($page.url.pathname)}`);
      if (!res.ok) return;
      const data = await res.json();
      comments = data.annotations ?? [];
    } catch { /* best-effort */ }
  }
  async function ackComment(id) {
    try {
      const res = await fetch(`/api/annotations/${id}`, { method: 'DELETE' });
      if (!res.ok) return;
      comments = comments.filter((c) => c.id !== id);
      expandedIds.delete(id);
      expandedIds = new Set(expandedIds);
    } catch { /* silent */ }
  }
  function toggleExpand(id) {
    if (expandedIds.has(id)) expandedIds.delete(id); else expandedIds.add(id);
    expandedIds = new Set(expandedIds);
  }

  // ── positioning ───────────────────────────────────────────────────────────
  function stickyPos(c) {
    positionTick; // re-evaluate on scroll/resize
    const el = findElement(c.anchor_selector);
    if (!el) return { left: 0, top: 0, visible: false };
    const rect = el.getBoundingClientRect();
    const ox = c.anchor_offset_x ?? 0.5, oy = c.anchor_offset_y ?? 0.5;
    let left = rect.left + rect.width * ox;
    let top = rect.top + rect.height * oy;
    left = Math.max(8, Math.min(window.innerWidth - 280 - 8, left));
    top = Math.max(8, Math.min(window.innerHeight - 60 - 8, top));
    return { left, top, visible: rect.bottom > 0 && rect.top < window.innerHeight };
  }
  function clampComposerPos() {
    if (!composer) return { left: 0, top: 0 };
    const W = 300, H = 180;
    let left = composer.x - W / 2;
    let top = composer.y + 12;
    left = Math.max(8, Math.min(window.innerWidth - W - 8, left));
    if (top + H + 8 > window.innerHeight) top = Math.max(8, composer.y - H - 12);
    return { left, top };
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────
  onMount(() => {
    pageLoaded = true;
    void loadComments();
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', cancelPress);
    document.addEventListener('pointercancel', cancelPress);
    document.addEventListener('contextmenu', onContextMenu);
    scrollHandler = () => positionTick++;
    resizeHandler = () => positionTick++;
    window.addEventListener('scroll', scrollHandler, { passive: true });
    window.addEventListener('resize', resizeHandler);
  });
  onDestroy(() => {
    if (typeof document === 'undefined') return;
    document.removeEventListener('pointerdown', onPointerDown);
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', cancelPress);
    document.removeEventListener('pointercancel', cancelPress);
    document.removeEventListener('contextmenu', onContextMenu);
    if (scrollHandler) window.removeEventListener('scroll', scrollHandler);
    if (resizeHandler) window.removeEventListener('resize', resizeHandler);
  });

  // Reload when the route changes (client navigation).
  let lastPath = $state('');
  $effect(() => {
    const p = $page.url.pathname;
    if (pageLoaded && p !== lastPath) { lastPath = p; void loadComments(); }
  });

  function timeAgo(ts) {
    const ms = typeof ts === 'number' ? ts : Date.parse(String(ts).replace(' ', 'T') + 'Z');
    const d = Math.round((Date.now() - ms) / 1000);
    if (!Number.isFinite(d)) return '';
    if (d < 60) return `${d}s`;
    if (d < 3600) return `${Math.round(d / 60)}m`;
    if (d < 86400) return `${Math.round(d / 3600)}h`;
    return `${Math.round(d / 86400)}d`;
  }
</script>

<!-- Pin layer: floating sticky notes anchored to elements -->
<div class="sticky-layer" data-sticky-ui="true">
  {#each comments as c (c.id)}
    {@const pos = stickyPos(c)}
    {#if pos.visible}
      {#if expandedIds.has(c.id)}
        <div class="sticky open" style:left="{pos.left}px" style:top="{pos.top}px" data-sticky-ui="true">
          <div class="sk-head">
            <span class="sk-who">{c.author || '?'}</span>
            <span class="sk-when">{timeAgo(c.created_at)}</span>
            <button class="sk-x" onclick={() => toggleExpand(c.id)} title="collapse">−</button>
          </div>
          <div class="sk-body">{c.body}</div>
          {#if c.anchor_snippet}
            <div class="sk-snip">"{c.anchor_snippet}"</div>
          {/if}
          <button class="sk-ack" onclick={() => ackComment(c.id)}>ack &amp; remove</button>
        </div>
      {:else}
        <button
          class="sticky-pin"
          style:left="{pos.left}px"
          style:top="{pos.top}px"
          data-sticky-ui="true"
          title={c.body}
          onclick={() => toggleExpand(c.id)}
        >{(c.author || '?').charAt(0).toUpperCase()}</button>
      {/if}
    {/if}
  {/each}
</div>

<!-- Composer popup -->
{#if composer}
  {@const pos = clampComposerPos()}
  <div
    class="composer-bd"
    data-sticky-ui="true"
    onpointerdown={(e) => { if (e.target === e.currentTarget) closeComposer(); }}
  ></div>
  <div class="composer" style:left="{pos.left}px" style:top="{pos.top}px" data-sticky-ui="true">
    <div class="cm-head">
      <span class="cm-snip">"{composer.anchor_snippet || 'no text'}"</span>
      <button class="sk-x" onclick={closeComposer} title="close">×</button>
    </div>
    <!-- svelte-ignore a11y_autofocus -->
    <textarea bind:value={composer.body} placeholder="leave a note…" rows="3" autofocus data-sticky-ui="true"></textarea>
    <div class="cm-actions">
      <button class="cm-cancel" onclick={closeComposer}>cancel</button>
      <button class="cm-send" onclick={submitComposer} disabled={composer.submitting || !composer.body.trim()}>
        {composer.submitting ? 'sending…' : 'send'}
      </button>
    </div>
  </div>
{/if}
