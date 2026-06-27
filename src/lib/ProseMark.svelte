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
  // ── ProseMark editor — PIXEL-PORT of the PetalNet design-system editor ──
  // A single WYSIWYM markdown surface on CodeMirror 6 (@prosemark/core): markdown
  // renders inline as you type, only the active line shows its raw "#"/marks. There
  // is deliberately NO read/preview pane here — the task page already renders the
  // SAVED body through the real `.prose` pipeline (server md.js -> bodyHtml), so the
  // non-editing view IS the pixel-identical preview. A second in-editor renderer would
  // only diverge from it. This component is edit-only; the parent owns read.
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
      mountEl.innerHTML = '<div style="padding:18px 20px;color:var(--text-mute);font-size:13px">Editor failed to load.</div>';
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
  <div class="pm-bar">
    <span class="pm-ico" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/></svg></span>
    <span class="pm-label">Editor</span>
  </div>
  <div class="pm-pane" id="pm-edit"><div id="pm-mount" bind:this={mountEl}></div></div>
  {#if name}<input type="hidden" {name} value={value} />{/if}
</div>

<style>
  /* ── Self-hosted Geist (mirrors the ds site / fontless output) ─────────── */
  :global(.pm-fontface) {} /* anchor */
  @font-face { font-family: 'Geist'; font-style: normal; font-weight: 400; font-display: swap; src: url('/fonts/geist-latin-400-normal.woff2') format('woff2'); }
  @font-face { font-family: 'Geist'; font-style: normal; font-weight: 500; font-display: swap; src: url('/fonts/geist-latin-500-normal.woff2') format('woff2'); }
  @font-face { font-family: 'Geist'; font-style: normal; font-weight: 600; font-display: swap; src: url('/fonts/geist-latin-600-normal.woff2') format('woff2'); }
  @font-face { font-family: 'Geist Mono'; font-style: normal; font-weight: 400; font-display: swap; src: url('/fonts/geist-mono-latin-400-normal.woff2') format('woff2'); }
  @font-face { font-family: 'Geist Mono'; font-style: normal; font-weight: 500; font-display: swap; src: url('/fonts/geist-mono-latin-500-normal.woff2') format('woff2'); }
  @font-face { font-family: 'Geist Fallback'; src: local('Arial'); size-adjust: 121.8125%; ascent-override: 82.5039%; descent-override: 24.2176%; line-gap-override: 0%; }
  @font-face { font-family: 'Geist Mono Fallback'; src: local('Courier New'), local('Courier'); size-adjust: 99.9833%; ascent-override: 100.5168%; descent-override: 29.5049%; line-gap-override: 0%; }

  /* ── token island: the editor is a faithful petal / paper-ink surface,
     self-contained so it renders pixel-identical to the ds reference
     regardless of the host app's (amber) theme. Light by default; dark under
     [data-theme='dark'] mirrors the ds dark tokens. ──────────────────────── */
  :global(.pm-shell) {
    --bg: #ffffff; --surface: #f6f5f3; --elev: #fbfaf9;
    --rule: #ececea; --rule-strong: #d9d7d3;
    --text: #161412; --text-mute: #645f59; --text-soft: #97928b;
    --petal: #bc5638; --on-petal: #ffffff;
    --petal-soft: color-mix(in srgb, var(--petal) 11%, transparent);
    --petal-wash: color-mix(in srgb, var(--petal) 5.5%, transparent);
    --petal-hover: color-mix(in srgb, var(--petal) 86%, #000);
    --danger: #c5374b;
    --font-sans: 'Geist', 'Geist Fallback', system-ui, -apple-system, sans-serif;
    --font-mono: 'Geist Mono', 'Geist Mono Fallback', ui-monospace, monospace;
    --radius: 0.75rem; --radius-sm: 0.5rem; --radius-xs: 0.125rem;
    --s2: 0.5rem;
    --t: 160ms cubic-bezier(.2, 0, 0, 1);
  }
  :global([data-theme='dark'] .pm-shell) {
    --bg: #0d0c0b; --surface: #161413; --elev: #1d1b19;
    --rule: #262321; --rule-strong: #36322f;
    --text: #ece8e3; --text-mute: #9a938b; --text-soft: #645e57;
    --petal: #e2725b; --on-petal: #0d0c0b;
    --petal-soft: color-mix(in srgb, var(--petal) 15%, transparent);
    --petal-hover: color-mix(in srgb, var(--petal) 86%, #000);
  }

  /* ── ProseMark editor themed to spec (verbatim from the ds site) ───────── */
  :global(.pm-shell) {
    --pm-link-color: var(--petal); --pm-cursor-color: var(--petal);
    --pm-header-mark-color: var(--text-soft); --pm-muted-color: var(--text-mute);
    --pm-code-font: var(--font-mono); --pm-code-background-color: var(--surface);
    --pm-code-btn-background-color: var(--surface); --pm-code-btn-hover-background-color: var(--elev);
    --pm-blockquote-vertical-line-background-color: var(--rule-strong);
    --pm-syntax-keyword: var(--petal); --pm-syntax-string: var(--text); --pm-syntax-comment: var(--text-soft);
    --pm-syntax-atom: var(--petal); --pm-syntax-literal: var(--text); --pm-syntax-link: var(--petal);
    --pm-syntax-class-name: var(--text); --pm-syntax-definition-property: var(--text);
    --pm-syntax-definition-variable: var(--text); --pm-syntax-local-variable: var(--text);
    --pm-syntax-special-variable-macro: var(--text); --pm-syntax-type-namespace: var(--text-mute);
    --pm-syntax-regexp: var(--text); --pm-syntax-invalid: var(--danger);
    border-radius: var(--radius); background: var(--bg); overflow: hidden;
    box-shadow: inset 0 0 0 1px var(--rule-strong); outline: 0;
    transition: box-shadow var(--t), background var(--t), outline-color var(--t);
  }
  :global(.pm-shell:has(.cm-editor.cm-focused)) { box-shadow: inset 0 0 0 1px var(--rule-strong), 0 0 0 2px var(--petal); outline: none; }
  :global(.pm-bar) { display: flex; align-items: center; gap: var(--s2); padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--rule); background: var(--surface); transition: background var(--t), border-color var(--t); }
  :global(.pm-bar .pm-ico) { width: 0.875rem; height: 0.875rem; color: var(--petal); display: inline-flex; }
  :global(.pm-bar .pm-ico svg) { width: 100%; height: 100%; }
  :global(.pm-bar .pm-label) { font: 500 0.6875rem var(--font-mono); letter-spacing: .04em; text-transform: uppercase; color: var(--text-mute); }
  :global(.pm-shell .cm-editor) { font: 14px/1.6 var(--font-sans); color: var(--text); background: var(--bg); }
  :global(.pm-shell .cm-editor.cm-focused) { outline: none; }
  :global(.pm-shell .cm-scroller) { font-family: var(--font-sans); font-size: 14px; line-height: 1.6; }
  :global(.pm-shell .cm-content) { padding: 18px 20px; caret-color: var(--petal); max-width: none; font-size: 14px; line-height: 1.6; }
  :global(.pm-shell .cm-line) { padding: 0; line-height: 1.6; }
  :global(.pm-shell .cm-fenced-code-line) { box-shadow: -12px 0 0 0 var(--pm-code-background-color), 12px 0 0 0 var(--pm-code-background-color); }
  :global(.pm-shell .cm-fenced-code-line.cm-soft-indent-line) { padding-inline-start: 0 !important; text-indent: 0 !important; }
  :global(.pm-shell .cm-selectionBackground), :global(.pm-shell .cm-content ::selection) { background: var(--petal-soft) !important; }
  :global(.pm-shell .cm-focused .cm-selectionBackground), :global(.pm-shell ::selection) { background: var(--petal-soft) !important; }
  :global(.pm-shell .cm-cursor) { border-left-color: var(--petal); }
  :global(.pm-shell .cm-activeLine), :global(.pm-shell .cm-activeLineGutter) { background: transparent; }
  :global(.pm-shell .cm-inline-code), :global(.pm-shell code), :global(.pm-shell .cm-monospace) { font-family: var(--font-mono); font-size: 12.5px; }
  :global(.pm-shell .cm-inline-code) { background: var(--surface); border-radius: var(--radius-xs); padding: 1px 4px; }
  :global(.pm-shell .cm-rendered-link), :global(.pm-shell .cm-url), :global(.pm-shell .cm-link) { color: var(--petal); }
  :global(.pm-shell .cm-blockquote-line) { color: var(--text); }
  :global(.pm-shell .cm-rendered-list-mark) { color: var(--petal); }
  :global(.pm-shell .cm-gutters) { display: none; }
  :global(.pm-shell .cm-code-block-info) { margin-top: 4px; margin-right: 8px; }
  :global(.pm-shell .cm-code-block-lang-container) { color: var(--petal); }
  :global(.pm-shell .cm-code-block-copy-button) { color: var(--petal); }
  :global(.pm-shell .cm-code-block-copy-button:hover) { color: var(--petal-hover); }
</style>
