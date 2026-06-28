<script module>
  // createProseMark factory, lazily imported from the self-hosted bundle and
  // cached across instances — EXACTLY like the design-system site. The bundle
  // (~860KB) is never statically imported, so it can't gate first paint.
  let _pmPromise = null;
  function loadProseMark() {
    const url = '/vendor/' + 'prosemark.bundle.js';
    if (!_pmPromise) _pmPromise = import(/* @vite-ignore */ url).then((m) => m.createProseMark);
    return _pmPromise;
  }
  // Warm the bundle BEFORE the user commits to editing (call on Edit-button hover/
  // focus/touchstart). The cached promise means the later mount is instant instead of
  // paying the ~860KB fetch+parse on click — kills the cold-start lag.
  export function preloadProseMark() { try { loadProseMark(); } catch {} }
</script>

<script>
  // ── ProseMark editor — a WYSIWYM markdown surface (CodeMirror 6 / @prosemark/core)
  // themed to render LINE-FOR-LINE like the saved task body. The task page already shows
  // the saved body through the real `.prose` pipeline (server md.js -> bodyHtml); this
  // editor is styled to match that .prose render (same font, sizes, heading colors, card)
  // so flipping into edit mode doesn't shift the text — only the active line reveals its
  // raw "#"/marks. There is NO read/preview pane here; the parent owns the saved render.
  let { value = $bindable(''), name = '' } = $props();

  let mountEl = $state(null);   // div ProseMark mounts the EditorView into
  let view = null;              // the EditorView createProseMark returns
  let status = 'idle';          // idle | loading | ready | failed

  async function ensureEditor() {
    if (view || !mountEl) return;
    status = 'loading';
    try {
      const createProseMark = await loadProseMark();
      if (view) return;
      view = createProseMark(mountEl, value ?? '');
      status = 'ready';
    } catch (e) {
      status = 'failed';
      mountEl.innerHTML = '<div style="padding:18px 20px;color:var(--text-3);font-size:13px">Editor failed to load.</div>';
      console.error('ProseMark mount failed', e);
    }
  }

  // pull the live markdown out of the EditorView (used on save by the parent)
  export function sync() {
    if (status === 'ready' && view) {
      try { value = view.state.doc.toString(); } catch {}
    }
    return value;
  }

  // mount the editor as soon as its host div is in the DOM
  $effect(() => {
    if (mountEl && !view && status !== 'failed') { ensureEditor(); }
  });
</script>

<div class="pm-shell" id="pm-shell">
  <div class="pm-pane" id="pm-edit"><div id="pm-mount" bind:this={mountEl}></div></div>
  {#if name}<input type="hidden" {name} value={value} />{/if}
</div>

<style>
  /* The editor is a .bodycard-equivalent surface: it inherits the APP tokens (so colors
     theme-switch with the app, not a separate island) and its rendered markdown is themed
     to match the saved `.prose` render. The CodeMirror WYSIWYM output uses GENERATED
     highlight classes for headings/strong (ͼq=h1, ͼr=h2, ͼx=strong) — these are pinned to
     the vendored static/vendor/prosemark.bundle.js; re-derive them if that bundle is ever
     rebuilt/replaced. Everything else targets stable .cm-* structural classes. */
  :global(.pm-shell) {
    /* bundle-read knobs -> app tokens */
    --pm-link-color: var(--accent-b);
    --pm-cursor-color: var(--accent);
    --pm-header-mark-color: var(--text-4);
    --pm-muted-color: var(--text-3);
    --pm-code-font: var(--mono);
    --pm-code-background-color: var(--surface-2);
    --pm-code-btn-background-color: var(--surface-2);
    --pm-code-btn-hover-background-color: var(--surface-3);
    --pm-blockquote-vertical-line-background-color: var(--accent);
    --pm-syntax-keyword: var(--accent-b); --pm-syntax-string: var(--text-1); --pm-syntax-comment: var(--text-4);
    --pm-syntax-atom: var(--accent-b); --pm-syntax-literal: var(--text-1); --pm-syntax-link: var(--accent-b);
    --pm-syntax-class-name: var(--text-1); --pm-syntax-definition-property: var(--text-1);
    --pm-syntax-definition-variable: var(--text-1); --pm-syntax-local-variable: var(--text-1);
    --pm-syntax-special-variable-macro: var(--text-1); --pm-syntax-type-namespace: var(--text-3);
    --pm-syntax-regexp: var(--text-1); --pm-syntax-invalid: #c5374b;
    /* card == .bodycard */
    background: var(--surface-1); border: 1px solid var(--border-sub); border-radius: var(--radius-lg);
    overflow: hidden; outline: 0; transition: box-shadow 160ms, border-color 160ms;
  }
  :global(.pm-shell:has(.cm-editor.cm-focused)) { border-color: var(--accent-ln); box-shadow: 0 0 0 2px var(--accent-bg); }

  /* base text == .prose (14.5px / 1.7, text-2, app sans) */
  :global(.pm-shell .cm-editor) { font: 14.5px/1.7 var(--sans); color: var(--text-2); background: transparent; }
  :global(.pm-shell .cm-editor.cm-focused) { outline: none; }
  :global(.pm-shell .cm-scroller) { font-family: var(--sans); font-size: 14.5px; line-height: 1.7; }
  :global(.pm-shell .cm-content) { padding: 18px 20px; caret-color: var(--accent); max-width: none; color: var(--text-2); }
  :global(.pm-shell .cm-line) { padding: 0; }
  :global(.pm-shell .cm-gutters) { display: none; }
  :global(.pm-shell .cm-cursor) { border-left-color: var(--accent); }
  :global(.pm-shell .cm-activeLine), :global(.pm-shell .cm-activeLineGutter) { background: transparent; }
  :global(.pm-shell .cm-selectionBackground), :global(.pm-shell .cm-content ::selection) { background: var(--accent-bg) !important; }
  :global(.pm-shell .cm-focused .cm-selectionBackground), :global(.pm-shell ::selection) { background: var(--accent-bg) !important; }

  /* headings == .prose h1/h2/h3 (override the bundle's baked heading scale). Scope the
     font-size to DIRECT children of .cm-line only: the rendered heading text span sits
     directly under .cm-line, while the raw "#" marks of INACTIVE headings are nested in
     .cm-hidden-token (which the bundle hides via font-size:0). A blanket .ͼr would re-size
     and re-reveal those hidden marks — the active-line marks stay (they're direct children
     and SHOULD show, like the ds editor's "# on the current line"). */
  :global(.pm-shell .cm-line > .ͼq) { font-size: 24px !important; font-weight: 700 !important; color: var(--text-1) !important; letter-spacing: -.02em !important; }
  :global(.pm-shell .cm-line > .ͼr) { font-size: 18px !important; font-weight: 600 !important; color: var(--accent-b) !important; letter-spacing: normal !important; }
  :global(.pm-shell .cm-line > .ͼs) { font-size: 15px !important; font-weight: 600 !important; color: var(--text-1) !important; letter-spacing: normal !important; }
  /* color the heading text even when nested, but never re-size hidden marks */
  :global(.pm-shell .ͼq:not(.ͼw)) { color: var(--text-1) !important; }
  :global(.pm-shell .ͼr:not(.ͼw)) { color: var(--accent-b) !important; }
  :global(.pm-shell .ͼs:not(.ͼw)) { color: var(--text-1) !important; }
  /* strong == .prose strong */
  :global(.pm-shell .ͼx) { color: var(--text-1) !important; font-weight: 600 !important; }
  /* .prose h2 has a full-width border-bottom rule. Only h2 lines carry a direct-child ͼr
     text span, so :has() targets exactly those (active or not) to draw the same underline. */
  :global(.pm-shell .cm-line:has(> .ͼr)) { border-bottom: 1px solid var(--border-sub); padding-bottom: 6px; }

  /* lists / quote / inline code / links / code blocks == .prose */
  :global(.pm-shell .cm-rendered-list-mark) { color: var(--text-2); }
  /* match .prose's list geometry: ul/ol padding-left:24px (indent) + li margin:5px 0 (gap).
     A list item is one soft-wrapped .cm-line carrying .cm-rendered-list-mark, so shift the
     whole item right and add inter-item spacing here (margin-inline keeps the bundle's hang). */
  :global(.pm-shell .cm-line:has(.cm-rendered-list-mark)) { margin-inline-start: 15px; margin-top: 5px; }
  :global(.pm-shell .cm-blockquote-line) { color: var(--text-3); font-style: italic; }
  :global(.pm-shell .cm-inline-code), :global(.pm-shell code), :global(.pm-shell .cm-monospace) { font-family: var(--mono); font-size: 13px; }
  :global(.pm-shell .cm-inline-code) { background: var(--surface-2); border: 1px solid var(--border-sub); border-radius: 5px; padding: 1px 6px; color: var(--accent-b); }
  :global(.pm-shell .cm-rendered-link), :global(.pm-shell .cm-url), :global(.pm-shell .cm-link) { color: var(--accent-b); }
  :global(.pm-shell .cm-fenced-code-line) { box-shadow: -12px 0 0 0 var(--surface-2), 12px 0 0 0 var(--surface-2); }
  :global(.pm-shell .cm-fenced-code-line.cm-soft-indent-line) { padding-inline-start: 0 !important; text-indent: 0 !important; }
  :global(.pm-shell .cm-code-block-info) { margin-top: 4px; margin-right: 8px; }
  :global(.pm-shell .cm-code-block-lang-container) { color: var(--accent-b); }
  :global(.pm-shell .cm-code-block-copy-button) { color: var(--accent-b); }
  :global(.pm-shell .cm-code-block-copy-button:hover) { color: var(--accent); }
</style>
