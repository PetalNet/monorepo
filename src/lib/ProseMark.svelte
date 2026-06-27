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
</script>

<script>
  // ── ProseMark editor — PIXEL-PORT of the PetalNet design-system editor ──
  // WYSIWYM markdown on CodeMirror 6 (@prosemark/core). Opens in a rendered READ
  // view (static HTML, paints instantly); flip to EDIT and the CodeMirror surface
  // mounts on demand. Read and edit share identical metrics so the swap doesn't
  // shift a pixel. The read view uses the SAME tiny markdown renderer the ds site
  // uses (renderMd below) so its geometry mirrors ProseMark's rendered output.
  let { value = $bindable(''), name = '', start = 'read' } = $props();

  let mode = $state(start === 'edit' ? 'edit' : 'read');  // 'read' | 'edit'
  let mountEl = $state(null);        // div ProseMark mounts the EditorView into
  let view = null;                   // the EditorView createProseMark returns
  let status = 'idle';               // idle | loading | ready | failed

  // ── tiny markdown → HTML renderer (verbatim from the ds site) ────────────
  // Mirrors ProseMark's rendered geometry so READ ⇄ EDIT is a visual no-op.
  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  const CODE_SENTINEL = 'CODE';
  function inline(raw) {
    const codes = [];
    let s = raw.replace(/`([^`]+)`/g, (_, c) => { codes.push(esc(c)); return CODE_SENTINEL + (codes.length - 1) + CODE_SENTINEL; });
    s = esc(s);
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, url) => (!/^(https?:\/\/|\/|#)/i.test(url) ? t : '<a href="' + url + '" rel="noopener">' + t + '</a>'));
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    s = s.replace(new RegExp(CODE_SENTINEL + '(\\d+)' + CODE_SENTINEL, 'g'), (_, i) => '<code>' + codes[+i] + '</code>');
    return s;
  }
  function renderMd(src) {
    const lines = (src || '').split('\n'); let html = '', i = 0;
    let blanks = 0, firstBlock = true;
    const sep = () => {
      const n = firstBlock ? 0 : Math.max(1, blanks);
      firstBlock = false; blanks = 0;
      return n ? ' style="margin-top:calc(' + n + ' * var(--pm-lh))"' : '';
    };
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*$/.test(line)) { blanks++; i++; continue; }
      const fence = line.match(/^```(.*)$/);
      if (fence) {
        const lang = (fence[1] || '').trim().split(/\s+/)[0];
        const langLabel = lang ? esc(lang.toUpperCase()) : '';
        const COPY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-copy-icon lucide-copy"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>';
        const chrome = '<span class="cm-code-block-info" contenteditable="false" aria-hidden="true"><span class="cm-code-block-lang-container">' + langLabel + '</span><button type="button" class="cm-code-block-copy-button" title="Copy code">' + COPY_SVG + '</button></span>';
        const buf = []; i++; while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(esc(lines[i])); i++; } i++;
        html += '<pre' + sep() + '>' + chrome + '<code>' + buf.join('\n') + '</code></pre>'; continue;
      }
      const h = line.match(/^(#{1,3})\s+(.*)$/);
      if (h) { const n = h[1].length; html += '<h' + n + sep() + '>' + inline(h[2]) + '</h' + n + '>'; i++; continue; }
      if (/^[-*]\s+/.test(line)) { html += '<ul' + sep() + '>'; while (i < lines.length && /^[-*]\s+/.test(lines[i])) { html += '<li>' + inline(lines[i].replace(/^[-*]\s+/, '')) + '</li>'; i++; } html += '</ul>'; continue; }
      if (/^>\s?/.test(line)) { const q = []; while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(lines[i].replace(/^>\s?/, '')); i++; } html += '<blockquote' + sep() + '><span class="bq-mark">&gt; </span>' + inline(q.join(' ')) + '</blockquote>'; continue; }
      const para = []; while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,3}\s|[-*]\s|>\s?|```)/.test(lines[i])) { para.push(lines[i]); i++; }
      html += '<p' + sep() + '>' + inline(para.join(' ')) + '</p>';
    }
    if (blanks > 0) html += '<div class="pm-trailing-blank" aria-hidden="true" style="height:calc(' + blanks + ' * var(--pm-lh))"></div>';
    return html;
  }

  // current rendered HTML for the read pane (recomputes when value changes)
  const readHtml = $derived(renderMd(value));

  // copy-button wiring on the rendered read view (nice-to-have, mirrors ds)
  function onReadClick(e) {
    const btn = e.target.closest('.cm-code-block-copy-button');
    if (!btn) return;
    const code = btn.closest('pre')?.querySelector('code');
    if (!code) return;
    try { navigator.clipboard?.writeText(code.textContent); } catch {}
  }

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

  // pull the live markdown out of the EditorView (used on toggle + by parents)
  export function sync() {
    if (status === 'ready' && view) {
      try { value = view.state.doc.toString(); } catch {}
    }
    return value;
  }

  function showRead() {
    sync();
    mode = 'read';
  }
  async function showEdit() {
    mode = 'edit';
    await ensureEditor();
    // if the doc changed underneath (parent set value), reflect it into CM
    if (view && view.state.doc.toString() !== (value ?? '')) {
      try { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value ?? '' } }); } catch {}
    }
    if (view) { try { view.focus(); } catch {} }
  }

  // when opened directly in edit mode (start='edit'), mount the editor as soon
  // as its host div is in the DOM — mirrors a manual Edit click.
  $effect(() => {
    if (mode === 'edit' && mountEl && !view && status !== 'failed') { ensureEditor(); }
  });
</script>

<div class="pm-shell" id="pm-shell">
  <div class="pm-bar">
    <span class="pm-ico" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/></svg></span>
    <span class="pm-label">Editor</span>
    <div class="pm-toggle" id="pm-toggle" role="group" aria-label="Read or edit">
      <button type="button" id="pm-read-btn" aria-pressed={mode === 'read'} onclick={showRead}>Read</button>
      <button type="button" id="pm-edit-btn" aria-pressed={mode === 'edit'} onclick={showEdit}>Edit</button>
    </div>
  </div>
  <!-- READ pane: rendered markdown (mirrors ProseMark's geometry) -->
  <div class="pm-pane pm-rendered" id="pm-read" hidden={mode !== 'read'} role="document" onclick={onReadClick}>{@html readHtml}</div>
  <!-- EDIT pane: the live ProseMark CodeMirror surface -->
  <div class="pm-pane" id="pm-edit" hidden={mode !== 'edit'}><div id="pm-mount" bind:this={mountEl}></div></div>
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

  /* Read ⇄ Edit toggle */
  :global(.pm-toggle) { margin-left: auto; display: inline-flex; gap: 0.125rem; background: var(--bg); box-shadow: inset 0 0 0 1px var(--rule); border-radius: 999px; padding: 0.125rem; transition: background var(--t); }
  :global(.pm-toggle button) { font: 500 0.71875rem var(--font-sans); letter-spacing: .02em; color: var(--text-mute); background: transparent; border: 0; padding: 0.25rem 0.8125rem; border-radius: 999px; cursor: pointer; transition: background var(--t), color var(--t); }
  :global(.pm-toggle button:hover) { color: var(--text); }
  :global(.pm-toggle button[aria-pressed='true']) { background: var(--petal-soft); color: var(--petal); }
  :global(.pm-pane[hidden]) { display: none; }

  /* Rendered READ view — PIXEL PARITY with the edit surface (verbatim ds) */
  :global(.pm-rendered) { padding: 18px 20px; color: var(--text); font: 14px/1.6 var(--font-sans); --pm-lh: 22.4px; }
  :global(.pm-rendered > *) { margin: 0; }
  :global(.pm-rendered > * + *) { margin-top: var(--pm-lh); }
  :global(.pm-rendered h1), :global(.pm-rendered h2), :global(.pm-rendered h3) { font-weight: 700; line-height: 1.6; letter-spacing: 0; margin: 0; }
  :global(.pm-rendered h1) { font-size: 1.6em; }
  :global(.pm-rendered h2) { font-size: 1.4em; }
  :global(.pm-rendered h3) { font-size: 1.2em; }
  :global(.pm-rendered p) { margin: 0; }
  :global(.pm-rendered strong) { font-weight: 700; }
  :global(.pm-rendered em) { font-style: italic; }
  :global(.pm-rendered a) { color: var(--petal); text-decoration: underline; }
  :global(.pm-rendered ul) { margin: 0; padding-left: 0; list-style: none; }
  :global(.pm-rendered ul > li) { margin: 0; padding-left: 19.6px; }
  :global(.pm-rendered ul > li::before) { content: '\2022'; color: var(--petal); display: inline-block; width: 10.8px; margin-left: -10.8px; font-size: 14px; }
  :global(.pm-rendered code) { font-family: var(--font-mono); font-size: 12.5px; background: var(--surface); border-radius: var(--radius-xs); padding: 1px 4px; }
  :global(.pm-rendered pre) { position: relative; font: 14px/1.6 var(--font-mono); background: var(--surface); border-radius: 0.4rem; padding: 1.6em 12px; margin: 0 -12px 0 -6px; overflow-x: auto; transition: background var(--t); tab-size: 4; -moz-tab-size: 4; }
  :global(.pm-rendered pre code) { background: none; border-radius: 0; padding: 0; font-size: 14px; }
  :global(.pm-rendered pre .cm-code-block-info) { position: absolute; top: 4px; right: 20px; display: flex; align-items: center; gap: 4.8px; padding: 3.2px; margin: 0; font: 14px/22.4px var(--font-mono); color: var(--petal); pointer-events: auto; }
  :global(.pm-rendered pre .cm-code-block-lang-container) { font: 400 12.8px/20.48px var(--font-mono); color: var(--petal); text-transform: none; letter-spacing: normal; }
  :global(.pm-rendered pre .cm-code-block-copy-button) { display: flex; align-items: center; justify-content: center; width: 22.4px; height: 22.4px; padding: 3.2px; margin: 0; border: 0; border-radius: 3.2px; background: var(--surface); color: var(--petal); cursor: pointer; transition: color var(--t); }
  :global(.pm-rendered pre .cm-code-block-copy-button:hover) { color: var(--petal-hover); }
  :global(.pm-rendered pre .cm-code-block-copy-button svg) { width: 16px; height: 16px; display: block; }
  :global(.pm-rendered .pm-trailing-blank) { margin: 0; }
  :global(.pm-rendered blockquote) { position: relative; margin: 0; padding-inline-start: 12px; text-indent: -6px; color: var(--text); }
  :global(.pm-rendered blockquote .bq-mark) { color: transparent; }
  :global(.pm-rendered blockquote::before) { content: ''; position: absolute; left: 6px; top: 0; bottom: 0; width: 4px; background: var(--rule-strong); }
</style>
