<script>
  import { enhance } from '$app/forms';
  import Icon from '$lib/Icon.svelte';
  import { projectName, whoColor } from '$lib/people.js';
  import { radioNav } from '$lib/a11y.js';
  import ProseMark, { preloadProseMark } from '$lib/ProseMark.svelte';
  let { data } = $props();
  const t = $derived(data.task);

  // Live lease countdown for in-progress tasks. lease_expires_at now ships to the
  // browser (only claim_token is scrubbed). Ticks client-side; display-only, so a
  // skewed clock just drifts a few seconds and self-corrects on reload.
  let now = $state(Date.now());
  $effect(() => { const i = setInterval(() => (now = Date.now()), 15000); return () => clearInterval(i); });
  const toMs = (s) => (s ? new Date(/[TZ]/.test(s) ? s : s.replace(' ', 'T') + 'Z').getTime() : NaN);
  function leaseInfo(expires) {
    const ms = toMs(expires);
    if (isNaN(ms)) return null;
    const s = Math.round((now - ms) / 1000); // >0 = overdue
    const a = Math.abs(s);
    const mag = a < 60 ? `${a}s` : a < 3600 ? `${Math.round(a / 60)}m` : a < 86400 ? `${Math.round(a / 3600)}h` : `${Math.round(a / 86400)}d`;
    return { state: s >= 0 ? 'expired' : s > -300 ? 'soon' : 'ok', label: s >= 0 ? `${mag} overdue` : `expires in ${mag}` };
  }
  const lease = $derived(leaseInfo(t.lease_expires_at));

  // whoColor single-sourced from $lib/people (this page's falsy fallback is the default 'var(--text-3)').
  const AGENTS = ['claude', 'agent-a', 'agent-b', 'codex', 'agent-d', 'agent-e'];
  const isAgent = (h) => AGENTS.includes(String(h).toLowerCase());
  const whoKind = (h) => isAgent(h) ? 'agent' : 'human';

  const projName = projectName(data.projects);
  const STATUSES = ['inbox', 'todo', 'doing', 'blocked', 'review', 'done', 'dropped'];
  const KIND_ICON = { task:'task', question:'question', doc:'doc', idea:'idea', upload:'doc' };
  const kindIcon = (k) => KIND_ICON[k] ?? 'task';

  function ago(ts) {
    if (!ts) return '';
    const d = (Date.now() - new Date(ts.replace(' ', 'T') + 'Z').getTime()) / 1000;
    if (d < 60) return 'just now';
    if (d < 3600) return Math.floor(d / 60) + 'm ago';
    if (d < 86400) return Math.floor(d / 3600) + 'h ago';
    return Math.floor(d / 86400) + 'd ago';
  }

  const isProse = $derived(t.kind === 'doc' || t.kind === 'idea');
  const isQuestion = $derived(t.kind === 'question');
  const isClosed = $derived(t.status === 'done' || t.status === 'dropped');
  const verif = $derived(t.verification_status || 'unverified');
  const verifClass = $derived(verif === 'unverified' ? 'none' : verif);

  // status → the three-bucket badge tone (open / in-progress / closed), GitHub-pill style
  const statusTone = (s) => (s === 'done' || s === 'dropped') ? 'done' : (s === 'doing' ? 'doing' : 'todo');

  // ── body version + narrator ───────────────────────────────────
  const hasHuman = $derived(!!data.bodyHtmlHuman);
  // default to the human version when one exists — that's the whole point.
  // initialise directly from data (not via an effect) so docHtml is correct on
  // the FIRST render — otherwise flipping it post-mount re-renders {@html} and
  // clobbers the glossary spans the effect just injected.
  let human = $state(!!data.bodyHtmlHuman); // show the plain-English rewrite
  let voice = $state('agent-a');     // TTS voice for Listen (server whitelists the key)

  const VOICES = [{ id: 'agent-a', label: 'Agent-a' }, { id: 'george', label: 'George' }, { id: 'river', label: 'River' }, { id: 'brian', label: 'Brian' }, { id: 'sarah', label: 'Sarah' }];
  const docHtml = $derived(human && hasHuman ? data.bodyHtmlHuman : data.bodyHtml);

  // restore the narrator voice once on mount, THEN allow saving — a `loaded` gate stops the
  // save effect from clobbering the stored value with the default before the load runs.
  let loaded = $state(false);
  $effect(() => {
    if (loaded) return;
    try {
      const p = JSON.parse(localStorage.getItem('reader') || '{}');
      if (typeof p.voice === 'string') voice = p.voice;
    } catch {}
    loaded = true;
  });
  $effect(() => {
    if (!loaded) return;
    try { localStorage.setItem('reader', JSON.stringify({ voice })); } catch {}
  });

  // ── glossary: wrap defined terms in the rendered prose with hover cards ──
  let proseEl = $state(null);
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  $effect(() => {
    docHtml; // re-run when the technical⇄human body swaps
    const el = proseEl;
    const terms = data.glossary;
    if (!el || !terms?.length) return;
    // A glossary definition entry renders as "<Term> <sep> definition" — the SAME
    // "- **Term** — def" shape parseGlossary matched. Match anchored at the entry
    // start against the known terms so we skip ONLY real definition list-items
    // (not arbitrary body bullets that happen to contain a dash).
    const defEntry = new RegExp(
      '^\\s*(?:' + terms.map((g) => escRe(g.term)).join('|') + ')\\s*(?:[—–:-]|--)\\s',
      'i'
    );
    // wrap each defined term at its FIRST occurrence (wiki-style), one term at a
    // time so two terms in the same text node both get wrapped.
    for (const { term, def } of terms) {
      // explicit word-char boundaries (not \b) so terms with non-word edges match too
      // — ".env", "C++", ".14" all have non-word first/last chars that \b can't bound.
      const re = new RegExp('(?<![A-Za-z0-9_])' + escRe(term) + '(?![A-Za-z0-9_])', 'i');
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          // skip headings, code, links, and any already-wrapped term
          if (n.parentElement?.closest('h1,h2,h3,h4,h5,h6,code,pre,a,.gloss')) return NodeFilter.FILTER_REJECT;
          // skip the glossary's own definition entries — otherwise a term's FIRST
          // occurrence is inside its "- **Term** — definition" <li>, so it self-wraps
          // there instead of in the body.
          const li = n.parentElement?.closest('li');
          if (li && defEntry.test(li.textContent)) return NodeFilter.FILTER_REJECT;
          return re.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }
      });
      const text = walker.nextNode();
      if (!text) continue;
      const m = text.nodeValue.match(re);
      const after = text.splitText(m.index);
      after.nodeValue = after.nodeValue.slice(m[0].length);
      const span = document.createElement('span');
      span.className = 'gloss';
      span.textContent = m[0];
      span.setAttribute('data-def', def);     // CSS hover card (pointer users)
      span.title = def;                        // native tooltip — touch long-press + fallback
      span.tabIndex = 0;                        // keyboard-focusable (hover card shows on focus)
      span.setAttribute('role', 'note');
      span.setAttribute('aria-label', `${m[0]}: ${def}`); // screen-reader gets the definition
      text.parentNode.insertBefore(span, after);
    }
  });

  // ── listen / podcast mode ──────────────────────────────────────
  // ElevenLabs when a key is on the box (server endpoint), else the
  // browser's built-in speech synth. No key required to use it.
  // ── body edit-on-demand ─────────────────────────────────────
  // The body renders as SANITIZED markdown by default (read mode, server-rendered
  // via renderMd → data.bodyHtml). An Edit button swaps in the raw-markdown textarea;
  // Save submits the existing ?/save form, Cancel reverts. This replaces the old
  // "always a raw textarea" UX where headings/lists/code never rendered.
  let editingBody = $state(false);
  let bodyDraft = $state('');            // textarea value (fallback editor + the submitted value)
  function startEditBody() { bodyDraft = t.body ?? ''; editingBody = true; }
  function cancelEditBody() { editingBody = false; }

  // ── ProseMark body editor — the pixel-identical design-system component. It encapsulates the
  //    lazy ~860KB bundle load, the CodeMirror WYSIWYM mount, read/edit modes, the heading "#"
  //    marker, and markdown sync (pmRef.sync() returns the live doc). Falls back internally.
  let pmRef = $state(null);   // bound ProseMark instance
  // Submit handler: write the editor's CURRENT markdown straight onto the outgoing FormData.
  // Mutate formData synchronously (NOT via a reactive bind flush) — enhance serializes the form
  // the instant submit fires, before Svelte flushes DOM updates; the direct set persists the edit.
  const saveBody = ({ formData }) => {
    const md = pmRef?.sync();
    if (md != null) { bodyDraft = md; formData.set('body', md); }
    return async ({ update }) => { await update(); editingBody = false; };
  };

  let speaking = $state(false);
  let loadingAudio = $state(false);
  // task-368: Listen state surfaced to AT — a polite live region announces
  // loading / playing / fallback / failure / stop instead of icon-only changes.
  let ttsStatus = $state('');
  let ttsErr = $state(false);     // failure states also render VISIBLY next to the button
  let audioEl = null;
  let ttsCtrl = null;       // AbortController for the in-flight TTS fetch
  let blobUrl = null;       // revoke on stop to avoid leaking
  function readableText() {
    // while editing the rendered prose isn't mounted — read the live editor instead
    if (editingBody && pmRef) return (pmRef.sync() || '').replace(/\s+\n/g, '\n').trim();
    return (proseEl?.innerText || '').replace(/\s+\n/g, '\n').trim();
  }
  function stopAudio(announce = false) {
    speaking = false; loadingAudio = false;
    if (announce) { ttsStatus = 'Narration stopped'; ttsErr = false; }
    try { ttsCtrl?.abort(); } catch {}
    ttsCtrl = null;
    try { window.speechSynthesis?.cancel(); } catch {}
    if (audioEl) { audioEl.onended = audioEl.onerror = null; audioEl.pause(); audioEl = null; }
    if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
  }
  // stop audio when the doc changes or the component unmounts (no orphan playback on nav)
  $effect(() => { t.id; return () => stopAudio(); });
  async function listen() {
    if (speaking || loadingAudio) { stopAudio(true); return; }   // task-368: announce stop on re-press
    const text = readableText();
    if (!text) return;
    loadingAudio = true;
    ttsStatus = 'Loading narration…'; ttsErr = false;
    ttsCtrl = new AbortController();
    // try the server TTS (ElevenLabs) first; fall back to browser speech
    try {
      const r = await fetch(`/task/${t.id}/tts`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: text.slice(0, 4800), voice }), signal: ttsCtrl.signal
      });
      if (r.ok && (r.headers.get('content-type') || '').includes('audio')) {
        blobUrl = URL.createObjectURL(await r.blob());
        audioEl = new Audio(blobUrl);
        audioEl.onended = () => { stopAudio(); ttsStatus = 'Narration finished'; };
        audioEl.onerror = () => { stopAudio(); ttsStatus = 'Audio unavailable'; ttsErr = true; };
        loadingAudio = false; speaking = true;
        ttsStatus = 'Playing narration';
        await audioEl.play();   // may reject (autoplay block / rapid toggle)
        return;
      }
    } catch (e) {
      if (e?.name === 'AbortError') return;   // user cancelled — don't fall through
    }
    // fallback: Web Speech API (task-368/313: never silent — surface every failure path)
    loadingAudio = false; speaking = false;
    if (!window.speechSynthesis) { ttsStatus = 'Audio unavailable'; ttsErr = true; return; }
    ttsStatus = 'Narration failed, using browser voice'; ttsErr = false;
    const u = new SpeechSynthesisUtterance(text.slice(0, 32000));
    u.rate = 1.0; u.pitch = 1.0;
    u.onend = () => { speaking = false; ttsStatus = 'Narration finished'; };
    // task-313: mid-utterance synthesis failure must reset the button (was stuck on "stop")
    u.onerror = () => { speaking = false; ttsStatus = 'Audio unavailable'; ttsErr = true; };
    speaking = true;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }

  // ── action bar ────────────────────────────────────────────────
  // The action bar presents the EXISTING server actions as obvious buttons instead of a
  // field-wall. Reassign + Mark-blocked are tiny inline forms hitting ?/save (the same action
  // the details form uses); Claim hits ?/claim (assign-to-self); Close opens the close panel;
  // Submit-decision (questions) scrolls to the one-tap answer pills. canWrite gates every
  // mutating action server-side; the UI hides the controls when read-only, but the gate is the
  // real boundary.
  const canWrite = $derived(!!data.canWrite);

  // ── inline sidebar field editing ───────────────────────────────
  // Every sidebar field is settable inline EVEN WHEN EMPTY: an "unset" value is itself a
  // click target that reveals the same control the populated state uses. `editField` holds
  // the name of the one field currently open (one at a time keeps the panel calm). Each opens
  // a tiny ?/save form (the SAME action the action bar + full edit form use) — no new actions.
  // canWrite still gates every mutation server-side; these controls only render when canWrite.
  let editField = $state(null);
  let editMore = $state(false);   // "Edit all fields" details open state (routing rows pop it open)
  const openField = (f) => { editField = f; };
  const closeField = () => { editField = null; };
  // close on save (use:enhance) so the populated value re-renders from fresh data
  const fieldSaved = () => async ({ update }) => { await update(); editField = null; };
  const ASSIGNEES = ['agent-a', 'claude', 'agent-b', 'codex', 'agent-d', 'agent-e'];
  const RESPONSIBLES = ['alice', 'bob'];

  let reassigning = $state(false);
  let showClose = $state(false);
  let closePanel = $state(null);
  let answersEl = $state(null);
  function openClose() { showClose = true; queueMicrotask(() => closePanel?.querySelector('input')?.focus()); }
  function jumpToAnswers() { answersEl?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }

  // activity timeline: fold the audit events + handoff/result/close/comments into one
  // chronological stream. Each entry is { who, kind, at, text?, bubble?, tone? }.
  // event 'data' is the parsed JSON payload from the server.
  const eventLabel = (e) => {
    const d = e.data || {};
    switch (e.type) {
      case 'create': return { who: d.by || t.created_by || 'someone', act: 'opened this task' };
      case 'update': return { who: d.by || 'someone', act: 'updated the task' };
      case 'claim':  return { who: d.worker || 'a worker', act: 'claimed the lease' };
      case 'report': return { who: d.worker || 'a worker', act: `reported · ${d.status || 'progress'}` };
      case 'closed': return { who: d.by || 'someone', act: 'closed this task', sub: d.reason };
      case 'handoff': return { who: d.from || 'someone', act: `handed off${d.to ? ' to ' + d.to : ''}`, kind: 'handoff' };
      default: return { who: d.by || d.worker || 'system', act: e.type };
    }
  };
  const timeline = $derived.by(() => {
    const items = [];
    for (const e of (data.events || [])) {
      const l = eventLabel(e);
      items.push({ ts: e.at, who: l.who, act: l.act, sub: l.sub, kind: l.kind || 'event', _o: e.id });
    }
    // worker result — a richer bubble, anchored to updated_at (no dedicated event for it)
    if (t.result_summary) {
      items.push({ ts: t.updated_at, who: t.assignee || t.claimed_by || 'worker', act: 'posted a result',
        kind: 'result', bubble: t.result_summary, verif: verif, _o: 1e15 });
    }
    for (const c of (data.comments || [])) {
      items.push({ ts: c.created_at, who: c.author || 'someone', act: 'left a comment', kind: 'comment', bubble: c.body, _o: 2e15 + c.id });
    }
    return items.sort((a, b) => {
      const ta = toMs(a.ts) || 0, tb = toMs(b.ts) || 0;
      return ta - tb || (a._o - b._o);
    });
  });
</script>

<svelte:head><title>#{t.id} {t.title} · tasks</title></svelte:head>

{#snippet avatar(handle, size)}
  {@const c = whoColor(handle)}
  {@const ag = isAgent(handle)}
  <span class="avatar" style="width:{size}px;height:{size}px;font-size:{Math.round(size * 0.42)}px;color:{c};border-color:{c};background:{ag ? 'transparent' : c + '22'};border-style:{ag ? 'dashed' : 'solid'}">{(handle || '?').charAt(0).toLowerCase()}</span>
{/snippet}

<div class="screen detail">

  <!-- breadcrumb -->
  <a class="back" href={projName(t.project_id) ? `/?project=${encodeURIComponent(projName(t.project_id))}` : '/'}>
    <span style="display:inline-flex;transform:scaleX(-1)"><Icon name="arrow" size={13} /></span>
    {projName(t.project_id) || 'board'} <span class="sep">·</span> board
  </a>

  <!-- ── clean header ──────────────────────────────────── -->
  <header class="head">
    {#if data.parent}
      <a class="parent-up mono" href="/task/{data.parent.id}">
        <span style="display:inline-flex;transform:rotate(-90deg)"><Icon name="arrow" size={13} /></span>
        part of #{data.parent.id} · {data.parent.title}
      </a>
    {/if}

    <div class="head-id">
      <span class="tnum mono">#{t.id}</span>
      <span class="kindtag kind-{t.kind}"><Icon name={kindIcon(t.kind)} size={12} /> {t.kind}</span>
      <span class="sbadge {statusTone(t.status)}"><span class="sdot"></span>{t.status}</span>
      <span class="pchip mono prio-{t.priority}">P{t.priority}</span>
      <span class="proj-tag">{projName(t.project_id) || '—'}</span>
      {#if t.up_next}<span class="proj-tag up">up next</span>{/if}
    </div>

    <!-- task-332: the page's one real h1 for AT/heading outlines; the input stays the
         visual + edit affordance (it is not a heading to a screen reader) -->
    <h1 class="vh">#{t.id} · {t.title}</h1>
    <form method="POST" action="?/save" use:enhance class="titleform">
      <input class="title-in" name="title" value={t.title} aria-label="Task title" readonly={!canWrite} />
    </form>

    {#if t.assignee || t.responsible}
      <div class="handoff-trail mono">
        {#if t.assignee}<span class="ht-seg">{@render avatar(t.assignee, 18)} <b style="color:{whoColor(t.assignee)}">{t.assignee}</b> <span class="dim">works it</span></span>{/if}
        {#if t.assignee && t.responsible}<span class="ht-arr"><Icon name="arrow" size={13} /></span>{/if}
        {#if t.responsible}<span class="ht-seg">{@render avatar(t.responsible, 18)} <b style="color:{whoColor(t.responsible)}">{t.responsible}</b> <span class="dim">responsible</span></span>{/if}
      </div>
    {/if}
  </header>

  {#if t.status === 'doing'}
    <div class="live-bar">
      {#if t.assignee}<span class="agent-badge">{@render avatar(t.assignee, 20)} <span style="color:{whoColor(t.assignee)}">{t.assignee}</span></span>{/if}
      <span class="lb-txt mono">in progress{t.capability ? ` · ${t.capability}` : ''}</span>
      {#if lease}<span class="lease lease-{lease.state}" title="lease {lease.label}">{t.claimed_by ? `leased to ${t.claimed_by} · ` : ''}{lease.label}</span>{/if}
    </div>
  {/if}

  <!-- ── ACTION BAR — the core fix: obvious "what do I do" buttons ── -->
  {#if canWrite}
    <div class="actionbar">
      <span class="ab-hint mono">do</span>

      {#if isQuestion}
        <button class="btn primary" type="button" onclick={jumpToAnswers}><Icon name="check" size={15} />Submit decision</button>
      {/if}

      {#if !isClosed}
        <form method="POST" action="?/claim" use:enhance class="ab-form">
          <button class="btn" type="submit"><Icon name="bolt" size={15} />Claim</button>
        </form>

        <button class="btn" type="button" class:on={reassigning} onclick={() => (reassigning = !reassigning)}><Icon name="task" size={15} />Reassign</button>

        {#if t.status !== 'blocked'}
          <form method="POST" action="?/save" use:enhance class="ab-form">
            <input type="hidden" name="status" value="blocked" />
            <button class="btn danger" type="submit"><Icon name="block" size={15} />Mark blocked</button>
          </form>
        {:else}
          <form method="POST" action="?/save" use:enhance class="ab-form">
            <input type="hidden" name="status" value="todo" />
            <button class="btn" type="submit"><Icon name="arrow" size={15} />Unblock</button>
          </form>
        {/if}
      {/if}

      <span class="ab-spacer"></span>

      {#if !isClosed && !isQuestion}
        <button class="btn" type="button" onclick={openClose}><Icon name="check" size={15} />Close…</button>
      {/if}
    </div>

    {#if reassigning}
      <form method="POST" action="?/save" use:enhance={() => async ({ update }) => { await update(); reassigning = false; }} class="reassign-row">
        <label class="rr-field">
          <span class="af-lbl">agent · works it</span>
          <select name="assignee" value={t.assignee ?? ''}>
            <option value="">— none —</option>
            <option value="agent-a">agent-a</option>
            <option value="claude">claude</option>
            <option value="agent-b">agent-b</option>
            <option value="codex">codex</option>
          </select>
        </label>
        <label class="rr-field">
          <span class="af-lbl">responsible · human</span>
          <select name="responsible" value={t.responsible ?? ''}>
            <option value="">— none —</option>
            <option value="alice">alice</option>
            <option value="bob">bob</option>
          </select>
        </label>
        <button class="btn-save-sm" type="submit">set</button>
        <button class="btn-ghost" type="button" onclick={() => (reassigning = false)}>cancel</button>
      </form>
    {/if}

    {#if showClose && !isClosed && !isQuestion}
      <div class="close-panel" bind:this={closePanel}>
        <form method="POST" action="?/close" use:enhance={() => async ({ update }) => { await update(); showClose = false; }} class="closeform">
          <input class="close-reason" name="reason" required placeholder="why is this closing? (the why-ledger — required)" />
          <select name="status" aria-label="Close as"><option value="done">done</option><option value="dropped">dropped</option></select>
          <button class="close-btn" type="submit">close</button>
          <button class="btn-ghost" type="button" onclick={() => (showClose = false)}>cancel</button>
        </form>
      </div>
    {/if}
  {/if}

  <!-- ── two-column issue layout ─────────────────────────── -->
  <div class="grid">

    <!-- MAIN COLUMN -->
    <div class="col-body">

      <!-- question: the violet one-tap answer / DECISION block -->
      {#if isQuestion}
        <section class="sec" bind:this={answersEl}>
          <div class="sec-head"><span class="ic"><Icon name="question" size={13} /></span><h2>Decision</h2></div>

          {#if data.bodyHtml}<div class="bodycard read"><div class="pm-rendered">{@html data.bodyHtml}</div></div>{/if}

          <!-- task-359: persistent live region — announces the answered confirmation the
               moment it lands (the region exists from mount, so AT reliably fires) -->
          <span class="vh" role="status" aria-live="polite">
            {t.answer ? `Answered: ${data.opts.find((o) => o.value === t.answer)?.label ?? t.answer}` : ''}
          </span>

          {#if t.answer}
            <div class="q-done">
              <span class="qd-check"><Icon name="check" size={20} /></span>
              <div>
                <div class="qd-title">answered</div>
                <div class="qd-sub mono">→ {data.opts.find((o) => o.value === t.answer)?.label ?? t.answer}</div>
              </div>
            </div>
          {/if}

          {#if data.opts.length}
            <!-- task-359: the options ARE mutually-exclusive answers — expose them that way.
                 fieldset+legend ties them to the question; radiogroup/radio + aria-checked
                 carries the selected state; radioNav adds the arrow-key/roving-tab contract. -->
            <fieldset class="answers" class:locked={t.answer} role="radiogroup"
              aria-label="Decision: {t.title}" use:radioNav>
              <legend class="vh">Decision: {t.title}</legend>
              {#each data.opts as o}
                <form method="POST" action="?/answer" use:enhance>
                  <input type="hidden" name="value" value={o.value} />
                  <button class="answer" class:on={t.answer === o.value} type="submit" disabled={!canWrite}
                    role="radio" aria-checked={t.answer === o.value}>
                    <span class="a-dot" aria-hidden="true"></span>
                    <span>{o.label}</span>
                  </button>
                </form>
              {/each}
            </fieldset>
          {:else}
            <!-- open question (no preset options): free-text answer -->
            <form method="POST" action="?/answer" use:enhance class="freeanswer">
              <textarea name="value" rows="3" placeholder="type your answer…" aria-label="Your answer" readonly={!canWrite}>{t.answer ?? ''}</textarea>
              {#if canWrite}<button class="q-submit" type="submit">{t.answer ? 'update answer' : 'send answer'}</button>{/if}
            </form>
          {/if}
        </section>
      {/if}

      {#snippet bodyEditor()}
        <!-- Save/Cancel live in the section header (the same slot as Edit) so nothing shifts
             between read and edit. This form is just the editor surface; the header's Save
             button submits it via form="bodyform". -->
        <form id="bodyform" method="POST" action="?/save" use:enhance={saveBody}>
          <input type="hidden" name="vis_touched" value="1" />
          <input type="hidden" name="private" value={t.visibility === 'private' ? '1' : ''} />
          <ProseMark bind:this={pmRef} bind:value={bodyDraft} name="body" />
        </form>
      {/snippet}

      <!-- BODY — unified for tasks, docs AND ideas (questions show context in the decision
           block). One rendered .prose surface at the task size, with a Listen (TTS) control
           available everywhere; Edit → the ProseMark WYSIWYM editor. The old doc/idea "reader"
           (font scaler / serif / wide / focus column) is gone — ideas now render exactly like a
           task, so the editor matches them too (Bob, task-518 follow-up). -->
      {#if !isQuestion}
        <section class="sec">
          <div class="sec-head">
            <span class="ic"><Icon name="doc" size={13} /></span>
            <h2>{t.kind === 'idea' ? 'Idea' : t.kind === 'doc' ? 'Document' : 'Description'}</h2>
            <!-- Tools live in the header in BOTH modes so nothing flips. The voice/listen stay;
                 the Edit button turns into Save (same slot, same style) with a Cancel beside it. -->
            <span class="right body-tools">
              {#if hasHuman && !editingBody}
                <!-- task-361: toggle state carried by aria-pressed, not color alone -->
                <div class="seg" role="group" aria-label="Version">
                  <button type="button" class="seg-btn" class:on={human} aria-pressed={human} onclick={() => (human = true)}>plain english</button>
                  <button type="button" class="seg-btn" class:on={!human} aria-pressed={!human} onclick={() => (human = false)}>technical</button>
                </div>
              {/if}
              {#if docHtml}
                <select class="rb voice" bind:value={voice} title="Narrator voice" aria-label="Narrator voice">
                  {#each VOICES as v}<option value={v.id}>{v.label}</option>{/each}
                </select>
                <!-- task-368: pressed state + a live status so AT hears loading/playing/failed -->
                <button type="button" class="rb listen" class:on={speaking} class:loading={loadingAudio}
                  title="Listen" aria-pressed={speaking || loadingAudio} onclick={listen}>
                  {#if loadingAudio}<span class="spin" aria-hidden="true"></span>{:else}<Icon name={speaking ? 'check' : 'arrow'} size={15} />{/if}
                  <span>{speaking ? 'stop' : loadingAudio ? '…' : 'listen'}</span>
                </button>
                <span class="tts-status mono" class:vh={!ttsErr} role="status" aria-live="polite">{ttsStatus}</span>
              {/if}
              {#if canWrite}
                {#if editingBody}
                  <button type="button" class="edit-btn" onclick={cancelEditBody}>Cancel</button>
                  <button type="submit" form="bodyform" class="edit-btn">Save</button>
                {:else}
                  <button type="button" class="edit-btn" onclick={startEditBody} onmouseenter={preloadProseMark} onfocus={preloadProseMark} ontouchstart={preloadProseMark}>Edit</button>
                {/if}
              {/if}
            </span>
          </div>

          {#if editingBody}
            <!-- Edit mode: the ProseMark WYSIWYM editor (shared bodyEditor snippet). Falls back to
                 a raw textarea if the lazy ESM bundle fails, so edits are never lost. -->
            {@render bodyEditor()}
          {:else if docHtml}
            {#if hasHuman && human}<div class="human-note mono"><Icon name="check" size={12} /> plain-english rewrite · switch to technical for the exact source</div>{/if}
            <div class="bodycard read"><article class="pm-rendered" bind:this={proseEl}>{@html docHtml}</article></div>
          {:else if canWrite}
            <button type="button" class="body-empty" onclick={startEditBody} onmouseenter={preloadProseMark} onfocus={preloadProseMark} ontouchstart={preloadProseMark}>No description yet — click to add the plan.</button>
          {:else}
            <div class="bodycard read"><p class="dim">No description.</p></div>
          {/if}
        </section>
      {/if}

      <!-- HIERARCHY — sub-tasks / children, first-class (all statuses) -->
      {#if data.childrenAll.length}
        <section class="sec">
          <div class="sec-head"><span class="ic"><Icon name="board" size={13} /></span><h2>Sub-tasks · {data.childrenAll.length}</h2></div>
          <div class="kid-list">
            {#each data.childrenAll as k (k.id)}
              <a class="kid-row" class:closed={k.status === 'done' || k.status === 'dropped'} href="/task/{k.id}">
                <span class="kid-dot prio-{k.priority}"></span>
                <span class="kid-num mono">#{k.id}</span>
                <span class="kid-title">{k.title}</span>
                {#if k.assignee}<span class="kid-asg mono" style="color:{whoColor(k.assignee)}">{k.assignee}</span>{/if}
                <span class="chip status-{k.status}">{k.status}</span>
              </a>
            {/each}
          </div>
        </section>
      {/if}

      <!-- relations: blocking deps (both directions) + non-blocking discovered-from provenance -->
      {#if data.blockers.length || data.blocking.length || data.discoveredFrom.length || data.discoveries.length}
        <section class="sec">
          <div class="sec-head"><span class="ic"><Icon name="block" size={13} /></span><h2>Relations</h2></div>
          <div class="rel-grid">
            {#snippet rellist(label, rows)}
              {#if rows.length}
                <div class="rel-col">
                  <div class="rel-lbl mono">{label} · {rows.length}</div>
                  <div class="kid-list">
                    {#each rows as r (r.id)}
                      <a class="kid-row" href="/task/{r.id}">
                        <span class="kid-dot prio-{r.priority}"></span>
                        <span class="kid-num mono">#{r.id}</span>
                        <span class="kid-title">{r.title}</span>
                        <span class="chip status-{r.status}">{r.status}</span>
                      </a>
                    {/each}
                  </div>
                </div>
              {/if}
            {/snippet}
            {@render rellist('blocked by', data.blockers)}
            {@render rellist('blocks', data.blocking)}
            {@render rellist('discovered from', data.discoveredFrom)}
            {@render rellist('discoveries', data.discoveries)}
          </div>
        </section>
      {/if}

      <!-- ── ACTIVITY TIMELINE (issue-comment style) ──────── -->
      <section class="sec">
        <div class="sec-head"><span class="ic"><Icon name="clock" size={13} /></span><h2>Activity</h2></div>

        <!-- handoff context — keep the dedicated callout when present -->
        {#if t.handoff_context}
          <div class="handoff mono"><span class="hc-lbl">handoff context</span>{t.handoff_context}</div>
        {/if}

        <div class="timeline">
          {#each timeline as it (it.kind + '-' + it._o)}
            <div class="tl-item">
              {@render avatar(it.who, 27)}
              <div class="tl-meta">
                <span class="who" style="color:{whoColor(it.who)}">{it.who}</span>
                <span class="act">{it.act}</span>
                {#if it.kind === 'handoff'}<span class="tl-kind mono">handoff</span>{/if}
                {#if it.kind === 'comment'}<span class="tl-kind mono">{whoKind(it.who)}</span>{/if}
                <span class="when mono">{ago(it.ts)}</span>
              </div>
              {#if it.kind === 'result'}
                <div class="tl-bubble result">
                  <div class="ttl">worker result <span class="verif v-{verifClass}">{it.verif === 'needs_human' ? 'needs human' : it.verif}</span></div>
                  {it.bubble}
                </div>
              {:else if it.kind === 'comment'}
                <div class="tl-bubble">{it.bubble}</div>
              {:else if it.sub}
                <div class="tl-event">{it.sub}</div>
              {/if}
            </div>
          {:else}
            <div class="tl-empty">no activity yet — start the thread below.</div>
          {/each}

          <!-- close reason as a terminal ledger entry when closed -->
          {#if isClosed && t.close_reason}
            <div class="tl-item">
              {@render avatar('alice', 27)}
              <div class="tl-meta"><span class="who">closed</span><span class="tl-kind mono">{t.status}</span></div>
              <div class="tl-bubble result"><div class="ttl">close reason</div>{t.close_reason}</div>
            </div>
          {/if}
        </div>

        {#if canWrite}
          <form method="POST" action="?/comment" use:enhance={() => async ({ update }) => update({ reset: true })} class="tl-comment-bar">
            <textarea name="body" rows="1" placeholder="Comment on this task…" aria-label="Comment on this task"
              onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.target.form.requestSubmit(); } }}></textarea>
            <button class="tl-send" type="submit" title="send" aria-label="Send message"><Icon name="arrow" size={17} /></button>
          </form>
        {/if}
      </section>
    </div>

    <!-- ── RIGHT SIDEBAR (the fields, tidy + secondary) ── -->
    <aside class="col-side">
      <details class="side-wrap" open>
        <summary>Details <span class="car"><Icon name="car" size={14} /></span></summary>
        <div class="side">

          <div class="sblock">
            <div class="slabel mono">Assignee</div>
            {#if editField === 'assignee' && canWrite}
              <form method="POST" action="?/save" use:enhance={fieldSaved} class="qedit-inline">
                <select name="assignee" value={t.assignee ?? ''} onchange={(e) => e.target.form.requestSubmit()} aria-label="Assignee">
                  <option value="">— none —</option>
                  {#each ASSIGNEES as a}<option value={a}>{a}</option>{/each}
                </select>
                <button type="button" class="field-x" onclick={closeField} aria-label="Cancel">×</button>
              </form>
            {:else if t.assignee}
              <button type="button" class="sval sval-edit" onclick={() => openField('assignee')} disabled={!canWrite}>{@render avatar(t.assignee, 22)}<span class="who" style="color:{whoColor(t.assignee)}">{t.assignee}</span></button>
            {:else if canWrite}
              <button type="button" class="sval is-unset sval-edit" onclick={() => openField('assignee')}>set assignee</button>
            {:else}<div class="sval is-unset">unset</div>{/if}
          </div>

          <div class="sblock">
            <div class="slabel mono">Status</div>
            <form method="POST" action="?/save" use:enhance class="qedit">
              <select class="chip status-{t.status}" name="status" value={t.status} onchange={(e) => e.target.form.requestSubmit()} aria-label="Status" disabled={!canWrite}>
                {#each STATUSES as s}<option value={s}>{s}</option>{/each}
              </select>
            </form>
          </div>

          <div class="sblock">
            <div class="slabel mono">Priority</div>
            <form method="POST" action="?/save" use:enhance class="qedit">
              <select class="chip prio-{t.priority}" name="priority" value={t.priority} onchange={(e) => e.target.form.requestSubmit()} aria-label="Priority" disabled={!canWrite}>
                {#each [0, 1, 2, 3] as p}<option value={p}>P{p}</option>{/each}
              </select>
            </form>
          </div>

          <div class="sblock">
            <div class="slabel mono">Project</div>
            {#if editField === 'project' && canWrite}
              <form method="POST" action="?/save" use:enhance={fieldSaved} class="qedit-inline">
                <select name="project_id" value={t.project_id ?? ''} onchange={(e) => e.target.form.requestSubmit()} aria-label="Project">
                  <option value="">— none —</option>
                  {#each data.projects as p}<option value={p.id}>{p.name}</option>{/each}
                </select>
                <button type="button" class="field-x" onclick={closeField} aria-label="Cancel">×</button>
              </form>
            {:else if projName(t.project_id)}
              <button type="button" class="sval sval-edit" onclick={() => openField('project')} disabled={!canWrite}><span class="who">{projName(t.project_id)}</span></button>
            {:else if canWrite}
              <button type="button" class="sval is-unset sval-edit" onclick={() => openField('project')}>set project</button>
            {:else}<div class="sval is-unset">—</div>{/if}
          </div>

          <div class="sblock">
            <div class="slabel mono">Responsible</div>
            {#if editField === 'responsible' && canWrite}
              <form method="POST" action="?/save" use:enhance={fieldSaved} class="qedit-inline">
                <select name="responsible" value={t.responsible ?? ''} onchange={(e) => e.target.form.requestSubmit()} aria-label="Responsible">
                  <option value="">— none —</option>
                  {#each RESPONSIBLES as r}<option value={r}>{r}</option>{/each}
                </select>
                <button type="button" class="field-x" onclick={closeField} aria-label="Cancel">×</button>
              </form>
            {:else if t.responsible}
              <button type="button" class="sval sval-edit" onclick={() => openField('responsible')} disabled={!canWrite}>{@render avatar(t.responsible, 22)}<span class="who" style="color:{whoColor(t.responsible)}">{t.responsible}</span></button>
            {:else if canWrite}
              <button type="button" class="sval is-unset sval-edit" onclick={() => openField('responsible')}>set responsible</button>
            {:else}<div class="sval is-unset">unset</div>{/if}
          </div>

          <div class="sblock">
            <div class="slabel mono">Blocked on</div>
            {#if editField === 'blocked_on' && canWrite}
              <form method="POST" action="?/save" use:enhance={fieldSaved} class="field-inline">
                <input name="blocked_on" value={t.blocked_on ?? ''} placeholder="what must clear first?" aria-label="Blocked on" autofocus />
                <div class="field-row"><button type="button" class="btn-ghost field-cancel" onclick={closeField}>cancel</button><button type="submit" class="btn-save-sm">set</button></div>
              </form>
            {:else if t.blocked_on}
              <button type="button" class="sval sval-edit" onclick={() => openField('blocked_on')} disabled={!canWrite}><span class="blk-on">{t.blocked_on}</span></button>
            {:else if canWrite}
              <button type="button" class="sval is-unset sval-edit" onclick={() => openField('blocked_on')}>set blocker</button>
            {:else}<div class="sval is-unset">nothing</div>{/if}
          </div>

          {#if !isProse && !isQuestion}
            <div class="sblock">
              <div class="slabel mono">Acceptance criteria</div>
              {#if editField === 'acceptance_criteria' && canWrite}
                <form method="POST" action="?/save" use:enhance={fieldSaved} class="field-inline">
                  <textarea name="acceptance_criteria" rows="3" placeholder="What 'done' means." aria-label="Acceptance criteria" autofocus>{t.acceptance_criteria ?? ''}</textarea>
                  <div class="field-row"><button type="button" class="btn-ghost field-cancel" onclick={closeField}>cancel</button><button type="submit" class="btn-save-sm">set</button></div>
                </form>
              {:else if t.acceptance_criteria}
                <button type="button" class="sval ac sval-edit" onclick={() => openField('acceptance_criteria')} disabled={!canWrite}>{t.acceptance_criteria}</button>
              {:else if canWrite}
                <button type="button" class="sval is-unset sval-edit" onclick={() => openField('acceptance_criteria')}>set criteria</button>
              {:else}<div class="sval is-unset">unset</div>{/if}
            </div>
          {/if}

          <!-- routing/handoff group — advisory; each row is a click target that opens the
               full edit form below (so even-empty routing fields are obviously settable). -->
          <details class="routing">
            <summary>Routing &amp; handoff <span class="adv mono">advisory</span><span class="car"><Icon name="car" size={14} /></span></summary>
            <div class="rt-body">
              {#snippet rtrow(label, val)}
                {#if canWrite}
                  <button type="button" class="rt-field rt-edit" onclick={() => (editMore = true)}><span class="rt-lbl mono">{label}</span><span class="rt-val mono" class:is-unset={!val}>{val || 'set…'}</span></button>
                {:else}
                  <div class="rt-field"><span class="rt-lbl mono">{label}</span><span class="rt-val mono" class:is-unset={!val}>{val || '—'}</span></div>
                {/if}
              {/snippet}
              {@render rtrow('Capability', t.capability)}
              {@render rtrow('Suggested agent', t.suggested_agent)}
              {@render rtrow('Owner machine', t.owner_machine)}
              {@render rtrow('Effort', t.effort)}
              {@render rtrow('Parallel group', t.parallel_group)}
            </div>
          </details>

          <!-- full edit form for the long-tail fields (acceptance, blocked-on, routing).
               Available for every kind so all sidebar fields are reachable even when empty;
               binds `editMore` so a routing-row click can pop it open. -->
          {#if canWrite}
            <details class="routing edit-more" bind:open={editMore}>
              <summary>Edit all fields <span class="car"><Icon name="car" size={14} /></span></summary>
              <form method="POST" action="?/save" use:enhance class="rt-body edit-form">
                <input type="hidden" name="vis_touched" value="1" />
                <label class="rt-field"><span class="rt-lbl mono">Acceptance criteria</span>
                  <textarea name="acceptance_criteria" rows="3" placeholder="What 'done' means.">{t.acceptance_criteria ?? ''}</textarea></label>
                <label class="rt-field"><span class="rt-lbl mono">Blocked on</span>
                  <input name="blocked_on" value={t.blocked_on ?? ''} placeholder="(what must clear first?)" /></label>
                <label class="rt-field"><span class="rt-lbl mono">Capability</span>
                  <input name="capability" value={t.capability ?? ''} placeholder="e.g. code · review" /></label>
                <label class="rt-field"><span class="rt-lbl mono">Owner machine</span>
                  <input name="owner_machine" value={t.owner_machine ?? ''} placeholder="e.g. dot14" /></label>
                <label class="rt-field"><span class="rt-lbl mono">Suggested agent</span>
                  <input name="suggested_agent" value={t.suggested_agent ?? ''} placeholder="e.g. agent-a" /></label>
                <label class="rt-field"><span class="rt-lbl mono">Effort</span>
                  <input name="effort" value={t.effort ?? ''} placeholder="xs · s · m · l" /></label>
                <label class="rt-field"><span class="rt-lbl mono">Parallel group</span>
                  <input name="parallel_group" value={t.parallel_group ?? ''} placeholder="group key" /></label>
                <label class="chk mono"><input type="checkbox" name="private" checked={t.visibility === 'private'} /> <Icon name="lock" size={12} /> private — only you</label>
                <button class="btn-save-sm" type="submit">save fields</button>
              </form>
            </details>
          {/if}
        </div>
      </details>
    </aside>

  </div>
</div>

<style>
  .screen.detail { max-width: 980px; }

  /* ── breadcrumb ──────────────────────────────────────────── */
  .back .sep { color: var(--text-4); margin: 0 2px; }

  /* ── clean header ────────────────────────────────────────── */
  .head { margin-bottom: 6px; }
  .parent-up {
    display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--text-3);
    padding: 5px 11px 5px 9px; border: 1px solid var(--border-sub); border-radius: var(--radius);
    background: var(--surface-1); margin-bottom: 12px; max-width: 100%; transition: .12s;
  }
  .parent-up:hover { color: var(--accent-b); border-color: var(--accent-ln); }
  .head-id { display: flex; align-items: center; gap: 9px; margin-bottom: 8px; flex-wrap: wrap; }
  .tnum { font-size: 14px; color: var(--text-4); font-weight: 600; }
  /* status badge — pill, like GitHub's open/closed */
  .sbadge { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600;
    padding: 4px 11px; border-radius: 20px; text-transform: lowercase; }
  .sbadge .sdot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .sbadge.todo { background: rgba(59,130,246,.16); color: var(--info-b); }
  .sbadge.doing { background: var(--accent-bg); color: var(--accent-b); }
  .sbadge.done { background: var(--surface-3); color: var(--text-3); }
  .pchip { font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: var(--radius-sm); }
  .pchip.prio-0 { background: rgba(220,38,38,.16); color: var(--danger-b); }
  .pchip.prio-1 { background: rgba(234,179,8,.16); color: var(--warn-b); }
  .pchip.prio-2, .pchip.prio-3 { background: rgba(59,130,246,.16); color: var(--info-b); }
  .proj-tag { font-size: 11px; color: var(--text-3); padding: 3px 9px; border: 1px solid var(--border-sub); border-radius: 20px; }
  .proj-tag.up { background: var(--accent-bg); color: var(--accent-b); border-color: var(--accent-ln); }

  /* editable title styled as the page h1 */
  .titleform { margin: 0; }
  .title-in {
    width: 100%; background: none; border: 1px solid transparent; border-radius: var(--radius);
    color: var(--text-1); font-family: var(--sans); font-size: clamp(22px, 3.4vw, 28px); font-weight: 700;
    letter-spacing: -.022em; line-height: 1.2; padding: 3px 7px; margin: 0 -7px; outline: none;
  }
  .title-in:hover:not([readonly]) { border-color: var(--border-sub); background: var(--surface-1); }
  .title-in:focus { border-color: var(--accent-ln); background: var(--surface-1); }
  .title-in[readonly] { cursor: default; }

  /* handoff trail */
  .handoff-trail { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 13px; font-size: 12px; }
  .ht-seg { display: inline-flex; align-items: center; gap: 7px; }
  .ht-arr { color: var(--text-4); }

  /* ── ACTION BAR ──────────────────────────────────────────── */
  .actionbar {
    display: flex; align-items: center; gap: 9px; flex-wrap: wrap; margin: 16px 0 0; padding: 12px 15px;
    background: var(--surface-1); border: 1px solid var(--border-sub); border-radius: var(--radius-lg);
  }
  .ab-form { display: contents; }
  .ab-hint { font-size: 10px; text-transform: uppercase; letter-spacing: .09em; color: var(--text-4); margin-right: 2px; }
  .btn {
    display: inline-flex; align-items: center; gap: 7px; font: inherit; font-size: 13px; font-weight: 600;
    padding: 9px 15px; border-radius: var(--radius); border: 1px solid var(--border); background: var(--surface-2);
    color: var(--text-1); cursor: pointer; transition: .12s; white-space: nowrap;
  }
  .btn svg { flex-shrink: 0; }
  .btn:hover { border-color: var(--text-4); background: var(--surface-3); }
  .btn.on { border-color: var(--accent-ln); color: var(--accent-b); background: var(--accent-bg); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #1a1205; }
  .btn.primary:hover { background: var(--accent-b); }
  .btn.danger:hover { border-color: var(--danger); color: var(--danger-b); background: rgba(220,38,38,.1); }
  .ab-spacer { margin-left: auto; }

  /* reassign inline row */
  .reassign-row {
    display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; margin-top: 8px; padding: 13px 15px;
    background: var(--surface-1); border: 1px solid var(--border-sub); border-radius: var(--radius);
  }
  .rr-field { display: flex; flex-direction: column; gap: 6px; }
  .reassign-row select {
    font: inherit; font-size: 14px; color: var(--text-1); background: var(--surface-2);
    border: 1px solid var(--border-sub); border-radius: var(--radius); padding: 9px 11px; cursor: pointer; outline: none;
  }
  .reassign-row select:focus { border-color: var(--accent-ln); }

  /* close panel */
  .close-panel { margin-top: 8px; padding: 13px 15px; background: var(--surface-1); border: 1px solid var(--border-sub); border-radius: var(--radius); }

  /* ── two-column grid ─────────────────────────────────────── */
  .grid { display: grid; grid-template-columns: 1fr 264px; gap: 26px; margin-top: 22px; align-items: start; }
  .col-body { min-width: 0; }

  /* section header inside body */
  .sec { margin-bottom: 26px; }
  .sec:last-child { margin-bottom: 0; }
  .sec-head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
  .sec-head h2 { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--text-3); }
  .sec-head .ic { display: flex; color: var(--text-4); }
  .sec-head .right { margin-left: auto; }
  .edit-btn {
    font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--text-3);
    background: var(--surface-1); border: 1px solid var(--border-sub); border-radius: var(--radius-sm);
    padding: 4px 11px; cursor: pointer; transition: .12s;
  }
  .edit-btn:hover { color: var(--accent-b); border-color: var(--accent-ln); }

  /* body card — rendered markdown */
  .bodycard { background: var(--surface-1); border: 1px solid var(--border-sub); border-radius: var(--radius-lg); padding: 18px 20px; }
  /* ── read view == edit view ──────────────────────────────────────────────
     The body read view (server/pm-render.js) is laid out to match the ProseMark
     editor (src/lib/ProseMark.svelte) line-for-line, so read↔edit is shift-free.
     Metrics MIRROR the editor's .cm-* CSS exactly: 14.5px/1.7, h 24/18/15px, h2
     underline, list 15px indent + 5px gap. Inter-block gaps come from the
     renderer's inline margin-top:calc(N * --pm-lh) (blank-line × line-height);
     :global() is required because the markup is injected via {@html}. */
  .pm-rendered { margin: 0; font: 14.5px/1.7 var(--sans); color: var(--text-2); --pm-lh: 24.65px; overflow-wrap: anywhere; }
  .pm-rendered :global(h1),
  .pm-rendered :global(h2),
  .pm-rendered :global(h3),
  .pm-rendered :global(p),
  .pm-rendered :global(ul),
  .pm-rendered :global(pre),
  .pm-rendered :global(blockquote) { margin: 0; }
  .pm-rendered :global(h1) { font-size: 24px; font-weight: 700; color: var(--text-1); letter-spacing: -.02em; line-height: 1.7; }
  .pm-rendered :global(h2) { font-size: 18px; font-weight: 600; color: var(--accent-b); line-height: 1.7; border-bottom: 1px solid var(--border-sub); padding-bottom: 6px; }
  .pm-rendered :global(h3) { font-size: 15px; font-weight: 600; color: var(--text-1); line-height: 1.7; }
  .pm-rendered :global(strong) { color: var(--text-1); font-weight: 600; }
  .pm-rendered :global(em) { font-style: italic; }
  .pm-rendered :global(a) { color: var(--accent-b); text-decoration: underline; text-underline-offset: 2px; }
  .pm-rendered :global(a.wikilink) { text-decoration: none; }
  .pm-rendered :global(code) { font-family: var(--mono); font-size: 13px; background: var(--surface-2); border: 1px solid var(--border-sub); border-radius: 5px; padding: 1px 6px; color: var(--accent-b); }
  .pm-rendered :global(ul) { padding: 0; list-style: none; }
  .pm-rendered :global(li) { position: relative; margin-inline-start: 38px; margin-top: 5px; }
  .pm-rendered :global(li::before) { content: "•"; position: absolute; margin-left: -18px; color: var(--text-2); }
  .pm-rendered :global(li.pm-task) { margin-inline-start: 0; }
  .pm-rendered :global(li.pm-task::before) { content: none; }
  .pm-rendered :global(li.pm-task > input[type="checkbox"]) { margin: 0 7px 0 -16px; vertical-align: -2px; accent-color: var(--accent); }
  .pm-rendered :global(li.pm-done) { color: var(--text-3); }
  .pm-rendered :global(blockquote) { color: var(--text-3); font-style: italic; border-left: 3px solid var(--accent); padding-left: 12px; }
  .pm-rendered :global(pre) { font-family: var(--mono); font-size: 13px; background: var(--surface-2); border: 1px solid var(--border-sub); border-radius: 8px; padding: 10px 12px; overflow-x: auto; }
  .pm-rendered :global(pre code) { background: none; border: 0; padding: 0; color: var(--text-2); }
  .pm-rendered :global(.cm-code-block-info) { display: flex; justify-content: flex-end; gap: 10px; align-items: center; margin-bottom: 4px; }
  .pm-rendered :global(.cm-code-block-lang-container) { color: var(--accent-b); font-size: 11px; }
  .pm-rendered :global(.cm-code-block-copy-button) { background: none; border: 0; padding: 0; color: var(--accent-b); cursor: pointer; }
  .pm-rendered :global(.pm-trailing-blank) { margin: 0; }
  .body-empty {
    width: 100%; text-align: left; font: inherit; font-size: 13.5px; color: var(--text-4);
    background: var(--surface-1); border: 1px dashed var(--border); border-radius: var(--radius-lg);
    padding: 16px 18px; cursor: pointer; transition: .12s;
  }
  .body-empty:hover { border-color: var(--accent-ln); color: var(--text-2); }

  /* edit mode: the ProseMark editor surface + all .cm-* theming now live inside ProseMark.svelte */
  /* Save/Cancel now live in the section header (.body-tools), not a bottom action bar. */
  .btn-ghost {
    font: inherit; font-size: 13px; color: var(--text-3); background: none; border: 1px solid var(--border-sub);
    border-radius: var(--radius); padding: 8px 16px; cursor: pointer; transition: .12s;
  }
  .btn-ghost:hover { color: var(--text-1); border-color: var(--border); }
  .btn-save-sm {
    font: inherit; font-size: 13px; font-weight: 600; color: #1a1205; background: var(--accent); border: none;
    border-radius: var(--radius); padding: 8px 18px; cursor: pointer; transition: .12s;
  }
  .btn-save-sm:hover { background: var(--accent-b); }

  /* ── question answer options (violet, one-tap) ───────────── */
  /* fieldset reset (task-359): the group is semantic, not visual — zero chrome */
  .answers { display: flex; flex-direction: column; gap: 7px; margin-top: 6px; border: 0; padding: 0; min-width: 0; }
  .answers form { display: contents; }
  .answer {
    display: flex; align-items: center; gap: 11px; width: 100%; text-align: left;
    padding: 13px 15px; background: var(--surface-1); border: 1px solid var(--border-sub);
    border-radius: var(--radius); color: var(--text-2); font: inherit; font-size: 14px; cursor: pointer; transition: .12s;
  }
  .answer:hover:not(:disabled) { border-color: var(--violet-ln); background: var(--violet-bg); }
  .answer:disabled { cursor: default; }
  .answer .a-dot { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--border); flex-shrink: 0; position: relative; transition: .1s; }
  .answer.on { border-color: var(--violet); background: var(--violet-bg); color: var(--violet-b); font-weight: 500; }
  .answer.on .a-dot { border-color: var(--violet); }
  .answer.on .a-dot::after { content: ''; position: absolute; inset: 3px; border-radius: 50%; background: var(--violet); }
  .answers.locked .answer:not(.on) { opacity: .55; }
  .q-done { display: flex; align-items: center; gap: 12px; margin: 4px 0 14px; padding: 12px 15px;
    background: var(--violet-bg); border: 1px solid var(--violet-ln); border-radius: var(--radius); }
  .q-done .qd-check { color: var(--violet-b); display: flex; }
  .q-done .qd-title { font-weight: 600; color: var(--violet-b); font-size: 13px; }
  .q-done .qd-sub { font-size: 12px; color: var(--text-3); }
  .freeanswer { display: flex; flex-direction: column; gap: 12px; }
  .freeanswer textarea {
    width: 100%; font: inherit; font-size: 14px; color: var(--text-1); resize: vertical;
    background: var(--surface-1); border: 1px solid var(--violet-ln); border-radius: var(--radius); padding: 12px 14px; outline: none;
  }
  .freeanswer textarea:focus { border-color: var(--violet); background: var(--surface-2); }
  .freeanswer .q-submit {
    align-self: flex-start; padding: 11px 20px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
    background: var(--violet); color: #04140a; border: none; border-radius: var(--radius);
  }

  /* verification chips */
  .verif { font-family: var(--mono); font-size: 9px; text-transform: uppercase; letter-spacing: .05em; padding: 2px 7px; border-radius: var(--radius-sm); }
  .verif.v-none { background: var(--surface-3); color: var(--text-4); }
  .verif.v-verified { background: var(--violet-bg); color: var(--violet-b); }
  .verif.v-rejected { background: rgba(220,38,38,.12); color: var(--danger-b); }
  .verif.v-needs_human { background: rgba(234,179,8,.14); color: var(--warn-b); }

  /* live lease countdown pill */
  .live-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 14px;
    padding: 10px 14px; background: var(--surface-1); border: 1px solid var(--accent-ln); border-radius: var(--radius); }
  .agent-badge { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 600; }
  .lb-txt { font-size: 11.5px; color: var(--text-3); }
  .lease { font-family: var(--mono); font-size: 11px; padding: 2px 8px; border-radius: 10px; white-space: nowrap; margin-left: auto; }
  .lease-expired { background: rgba(220,38,38,.14); color: var(--danger-b); }
  .lease-soon { background: rgba(234,179,8,.14); color: var(--warn-b); }
  .lease-ok { color: var(--text-4); }

  /* handoff context callout */
  .handoff { font-size: 12.5px; line-height: 1.55; color: var(--text-2); white-space: pre-wrap; margin-bottom: 16px;
    background: var(--surface-1); border: 1px solid var(--border-sub); border-radius: var(--radius); padding: 12px 14px; }
  .handoff .hc-lbl { color: var(--info-b); }
  .handoff .hc-lbl { display: block; font-size: 9px; text-transform: uppercase; letter-spacing: .06em; color: var(--text-4); margin-bottom: 5px; }

  /* close form */
  .closeform { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .close-reason {
    flex: 1; min-width: 180px; font: inherit; font-size: 14px; color: var(--text-1);
    background: var(--surface-2); border: 1px solid var(--border-sub); border-radius: var(--radius); padding: 10px 13px; outline: none;
  }
  .close-reason:focus { border-color: var(--accent-ln); }
  .closeform select {
    font: inherit; font-size: 13px; color: var(--text-1); background: var(--surface-2);
    border: 1px solid var(--border-sub); border-radius: var(--radius); padding: 9px 11px; cursor: pointer; outline: none;
  }
  .close-btn {
    padding: 9px 18px; border-radius: var(--radius); background: var(--accent); color: #1a1205;
    border: none; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; transition: .12s;
  }
  .close-btn:hover { background: var(--accent-b); }

  /* ── sub-task / relation rows ────────────────────────────── */
  .kid-list { display: flex; flex-direction: column; gap: 6px; }
  .kid-row {
    display: flex; align-items: center; gap: 10px; padding: 10px 13px; text-decoration: none;
    background: var(--surface-1); border: 1px solid var(--border-sub); border-radius: var(--radius); transition: .12s;
  }
  .kid-row:hover { border-color: var(--border); background: var(--surface-2); }
  .kid-row.closed .kid-title { color: var(--text-4); text-decoration: line-through; text-decoration-thickness: 1px; }
  .kid-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: var(--text-4); }
  .kid-dot.prio-0 { background: var(--danger-b); } .kid-dot.prio-1 { background: var(--warn-b); }
  .kid-dot.prio-2 { background: var(--info-b); } .kid-dot.prio-3 { background: var(--text-4); }
  .kid-num { font-size: 11px; color: var(--text-4); flex-shrink: 0; }
  .kid-title { flex: 1; min-width: 0; font-size: 13.5px; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kid-asg { font-size: 11px; flex-shrink: 0; }
  .kid-row .chip { margin-left: 0; flex-shrink: 0; }

  /* relations grid */
  .rel-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
  .rel-col { display: flex; flex-direction: column; gap: 8px; }
  .rel-lbl { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--text-3); }

  /* ── activity timeline ───────────────────────────────────── */
  .timeline { position: relative; padding-left: 36px; }
  .timeline::before { content: ''; position: absolute; left: 13px; top: 6px; bottom: 14px; width: 1.5px; background: var(--border-sub); }
  .tl-item { position: relative; margin-bottom: 18px; }
  .tl-item:last-child { margin-bottom: 0; }
  .tl-item :global(.avatar) { position: absolute; left: -36px; top: 0; z-index: 1; background: var(--bg); }
  .tl-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; margin-bottom: 6px; }
  .tl-meta .who { font-weight: 600; }
  .tl-meta .act { color: var(--text-3); }
  .tl-meta .when { font-size: 11px; color: var(--text-4); }
  .tl-kind { font-size: 9px; text-transform: uppercase; letter-spacing: .05em; color: var(--text-4); background: var(--surface-3); padding: 1px 6px; border-radius: var(--radius-sm); }
  .tl-event { font-size: 13px; color: var(--text-3); line-height: 1.5; }
  .tl-bubble { background: var(--surface-1); border: 1px solid var(--border-sub); border-radius: var(--radius);
    padding: 12px 15px; font-size: 13.5px; line-height: 1.6; color: var(--text-2); white-space: pre-wrap; }
  .tl-bubble .ttl { font-weight: 600; color: var(--text-1); margin-bottom: 5px; display: flex; align-items: center; gap: 8px; }
  .tl-bubble.result .ttl { color: var(--violet-b); }
  .tl-empty { font-size: 12.5px; color: var(--text-4); padding: 4px 0; }
  .tl-comment-bar {
    display: flex; align-items: flex-end; gap: 9px; margin-top: 18px; padding: 6px 6px 6px 16px;
    background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius-lg);
  }
  .tl-comment-bar textarea {
    flex: 1; font: inherit; font-size: 14px; background: none; border: none; outline: none; color: var(--text-1);
    padding: 10px 0; resize: none; max-height: 140px; line-height: 1.5;
  }
  .tl-comment-bar textarea::placeholder { color: var(--text-4); }
  .tl-send { width: 38px; height: 38px; flex-shrink: 0; border: none; border-radius: 50%; background: var(--accent);
    color: #1a1205; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: .12s; }
  .tl-send:hover { background: var(--accent-b); }

  /* ── right sidebar ───────────────────────────────────────── */
  .col-side { align-self: start; }
  .side { display: flex; flex-direction: column; }
  .sblock { padding: 13px 0; border-bottom: 1px solid var(--border-sub); }
  .sblock:first-child { padding-top: 0; }
  .slabel { font-size: 10px; text-transform: uppercase; letter-spacing: .07em; color: var(--text-4); margin-bottom: 8px; }
  .sval { display: flex; align-items: center; gap: 8px; font-size: 13.5px; color: var(--text-2); }
  .sval .who { font-weight: 500; color: var(--text-1); }
  .sval.is-unset { color: var(--text-4); font-style: italic; }

  /* inline-editable sidebar fields: the value (or "unset") is itself a click target
     that reveals the same control. styled as a borderless button so it reads like text. */
  button.sval-edit {
    font: inherit; font-size: 13.5px; text-align: left; width: 100%; background: none;
    border: 1px solid transparent; border-radius: var(--radius-sm); padding: 3px 6px; margin: -3px -6px;
    cursor: pointer; transition: .12s; color: inherit;
  }
  button.sval-edit:hover:not(:disabled) { border-color: var(--border-sub); background: var(--surface-1); }
  button.sval-edit:disabled { cursor: default; }
  button.sval-edit.is-unset { font-style: italic; color: var(--text-4); }
  button.sval-edit.is-unset:hover { color: var(--accent-b); border-color: var(--accent-ln); }
  button.sval-edit.ac { font-size: 12.5px; line-height: 1.5; white-space: pre-wrap; }
  /* the × cancel button beside an inline select */
  .qedit-inline { display: flex; align-items: center; gap: 6px; }
  .qedit-inline select {
    flex: 1; min-width: 0; font: inherit; font-size: 13px; color: var(--text-1); background: var(--surface-2);
    border: 1px solid var(--border-sub); border-radius: var(--radius-sm); padding: 7px 9px; cursor: pointer; outline: none;
  }
  .qedit-inline select:focus { border-color: var(--accent-ln); }
  .field-x { flex-shrink: 0; width: 24px; height: 24px; border: 1px solid var(--border-sub); border-radius: var(--radius-sm);
    background: var(--surface-1); color: var(--text-3); font-size: 15px; line-height: 1; cursor: pointer; transition: .12s; }
  .field-x:hover { color: var(--text-1); border-color: var(--border); }
  /* text/textarea inline editors */
  .field-inline { display: flex; flex-direction: column; gap: 8px; }
  .field-inline input, .field-inline textarea {
    width: 100%; font: inherit; font-size: 13px; color: var(--text-1); background: var(--surface-2);
    border: 1px solid var(--border-sub); border-radius: var(--radius-sm); padding: 8px 10px; outline: none; resize: vertical;
  }
  .field-inline input:focus, .field-inline textarea:focus { border-color: var(--accent-ln); }
  .field-row { display: flex; align-items: center; gap: 8px; justify-content: flex-end; }
  .field-row .btn-save-sm { padding: 6px 14px; font-size: 12px; }
  .field-cancel { padding: 6px 12px; font-size: 12px; }
  /* routing advisory rows as click-to-edit targets */
  button.rt-edit { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%;
    font: inherit; text-align: left; background: none; border: 1px solid transparent; border-radius: var(--radius-sm);
    padding: 4px 6px; margin: 0 -6px; cursor: pointer; transition: .12s; }
  button.rt-edit:hover { border-color: var(--border-sub); background: var(--surface-2); }
  button.rt-edit:hover .rt-val.is-unset { color: var(--accent-b); }
  .rt-val.is-unset { color: var(--text-4); opacity: .6; }
  .sval.ac { font-size: 12.5px; line-height: 1.5; white-space: pre-wrap; }
  .blk-on { color: var(--danger-b); font-size: 13px; }
  .side .chip { font-family: var(--mono); font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
    border: 1px solid transparent; appearance: none; -webkit-appearance: none; cursor: pointer; padding: 4px 10px; border-radius: var(--radius-sm); outline: none; }
  .side .chip:disabled { cursor: default; opacity: .8; }
  .qedit { display: contents; }

  /* collapsed routing/handoff group */
  .routing { border: 1px solid var(--border-sub); border-radius: var(--radius); background: var(--surface-1); margin-top: 13px; }
  .routing > summary { display: flex; align-items: center; gap: 8px; padding: 11px 13px; cursor: pointer; list-style: none;
    font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: .07em; color: var(--text-3); }
  .routing > summary::-webkit-details-marker { display: none; }
  .routing > summary:hover { color: var(--text-1); }
  .routing > summary .car { margin-left: auto; transition: transform .15s; color: var(--text-4); display: flex; }
  .routing[open] > summary .car { transform: rotate(180deg); }
  .routing > summary .adv { font-size: 9px; color: var(--text-4); letter-spacing: .04em; text-transform: none; opacity: .7; }
  .rt-body { padding: 2px 13px 13px; display: flex; flex-direction: column; gap: 11px; }
  .rt-field { display: flex; flex-direction: column; gap: 4px; }
  .rt-lbl { font-size: 9.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--text-4); }
  .rt-val { font-size: 12.5px; color: var(--text-3); }
  .edit-form input, .edit-form textarea {
    width: 100%; font: inherit; font-size: 13px; color: var(--text-1); background: var(--surface-2);
    border: 1px solid var(--border-sub); border-radius: var(--radius-sm); padding: 8px 10px; outline: none; resize: vertical;
  }
  .edit-form input:focus, .edit-form textarea:focus { border-color: var(--accent-ln); }
  .edit-form .chk { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-3); cursor: pointer; }
  .edit-form .chk input { width: auto; accent-color: var(--accent); }
  .edit-form .btn-save-sm { align-self: flex-start; }

  .dim { color: var(--text-4); }

  /* ── body tools (narrator + plain-english toggle), inline in the section header ── */
  .body-tools { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
  .rb { display: inline-flex; align-items: center; gap: 6px; justify-content: center; min-width: 30px; height: 30px;
    padding: 0 9px; border-radius: var(--radius); background: var(--surface-1); border: 1px solid var(--border-sub);
    color: var(--text-2); font: inherit; font-size: 12.5px; cursor: pointer; transition: .12s; }
  .rb:hover:not(:disabled) { border-color: var(--accent-ln); color: var(--text-1); }
  .rb:disabled { opacity: .35; cursor: default; }
  .rb.on { background: var(--accent-bg); border-color: var(--accent-ln); color: var(--accent-b); }
  .rb svg { display: block; }
  .rb.voice { appearance: none; -webkit-appearance: none; cursor: pointer; padding: 0 9px; font-size: 12px; }
  .listen.on { background: var(--accent); border-color: var(--accent); color: #1a1205; }
  .listen .spin { width: 13px; height: 13px; border-radius: 50%; border: 2px solid var(--border); border-top-color: var(--accent-b); animation: rspin .7s linear infinite; }
  @keyframes rspin { to { transform: rotate(360deg); } }
  .seg { display: inline-flex; padding: 2px; background: var(--surface-1); border: 1px solid var(--border-sub); border-radius: var(--radius); }
  .seg-btn { padding: 4px 11px; border: none; background: none; border-radius: calc(var(--radius) - 2px);
    color: var(--text-3); font: inherit; font-size: 11.5px; font-weight: 500; cursor: pointer; transition: .12s; white-space: nowrap; }
  .seg-btn.on { background: var(--accent-bg); color: var(--accent-b); }
  .seg-btn:not(.on):hover { color: var(--text-1); }
  /* task-368: TTS status — live-region always, VISIBLE when it's a failure state.
     AAA-measured: dark #ef8090 = 7.14:1 on surface-1; light needs a deeper red than
     --danger-b (#a52d3e = 6.62:1), so it darkens to #962939 = 7.54:1. */
  .tts-status { font-size: 11px; color: var(--danger-b); }
  :global([data-theme='light']) .tts-status { color: #962939; }
  .human-note { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--text-3); margin: 0 0 12px; }
  .human-note svg { color: var(--accent-b); }

  /* ── responsive: phone (sidebar drops below body, buttons stay reachable).
     @container app, NOT @media — aligned with the shell's single 760px breakpoint
     (task-333: mixing viewport + container units for the same layer is the drift class). ── */
  @container app (max-width: 760px) {
    .screen.detail { max-width: 100%; }
    .grid { grid-template-columns: 1fr; gap: 20px; }
    .col-side { order: 2; }
    .actionbar { position: sticky; top: 0; z-index: 4; }
    .ab-spacer { display: none; }
    .actionbar .btn { flex: 1; justify-content: center; }
    /* task-334: reader-bar controls reach the 44px minimum tap target on phone */
    .rb, .seg-btn, .edit-btn { min-height: 44px; }
    .rb { height: auto; padding: 0 12px; }
    .seg-btn { padding: 4px 13px; }
    .edit-btn { padding: 4px 14px; }
    .body-tools { gap: 8px; }
    /* sidebar collapses into its <details> on phone */
    .side-wrap > summary { display: flex; align-items: center; gap: 8px; cursor: pointer; list-style: none;
      font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: .07em; color: var(--text-3);
      padding: 12px 14px; background: var(--surface-1); border: 1px solid var(--border-sub); border-radius: var(--radius); }
    .side-wrap > summary::-webkit-details-marker { display: none; }
    .side-wrap > summary .car { margin-left: auto; transition: transform .15s; color: var(--text-4); display: flex; }
    .side-wrap[open] > summary .car { transform: rotate(180deg); }
    .side { padding: 6px 4px 0; }
  }
  /* on desktop the side-wrap <summary> is hidden — content always shown */
  @container app (min-width: 761px) { .side-wrap > summary { display: none; } .side-wrap > .side { display: flex; } }
</style>
