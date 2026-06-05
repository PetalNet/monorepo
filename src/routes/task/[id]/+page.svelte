<script>
  import { enhance } from '$app/forms';
  let { data } = $props();
  const t = $derived(data.task);

  const PERSON = { claude:'#fb923c', agent-a:'#8b5cf6', agent-b:'#22d3ee', alice:'#fb7185', alice:'#fb7185', bob:'#38bdf8', bob:'#38bdf8', codex:'#a3e635', agent-d:'#f472b6', agent-e:'#facc15' };
  const AGENTS = ['claude', 'agent-a', 'agent-b', 'codex', 'agent-d', 'agent-e'];
  const hue = (s) => { let h = 0; for (let i = 0; i < (s?.length ?? 0); i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; };
  const whoColor = (h) => h ? (PERSON[String(h).toLowerCase()] ?? `hsl(${hue(h)} 60% 68%)`) : 'var(--text-3)';
  const isAgent = (h) => AGENTS.includes(String(h).toLowerCase());
  const whoKind = (h) => isAgent(h) ? 'agent' : 'human';

  const projName = (id) => data.projects.find((p) => p.id === id)?.name ?? '';
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
  const verif = $derived(t.verification_status || 'unverified');
  const verifClass = $derived(verif === 'unverified' ? 'none' : verif);
</script>

<svelte:head><title>{t.title} · tasks</title></svelte:head>

{#snippet avatar(handle, size)}
  {@const c = whoColor(handle)}
  {@const ag = isAgent(handle)}
  <span class="avatar" style="width:{size}px;height:{size}px;font-size:{Math.round(size * 0.42)}px;color:{c};border-color:{c};background:{ag ? 'transparent' : c + '22'};border-style:{ag ? 'dashed' : 'solid'}">{(handle || '?').charAt(0).toLowerCase()}</span>
{/snippet}

<div class="screen detail">
  <header class="page-head">
    <a class="back" href={projName(t.project_id) ? `/?project=${encodeURIComponent(projName(t.project_id))}` : '/'}>
      <svg width="13" height="13" style="transform:scaleX(-1)"><use href="#i-arrow"/></svg>
      {projName(t.project_id) || 'board'}
    </a>

    <div class="det-meta">
      <span class="kindtag kind-{t.kind}"><svg width="12" height="12"><use href="#i-{kindIcon(t.kind)}"/></svg> {t.kind}</span>

      <form method="POST" action="?/save" use:enhance class="qedit">
        <select class="chip status-{t.status}" name="status" value={t.status} onchange={(e) => e.target.form.requestSubmit()} aria-label="Status">
          {#each STATUSES as s}<option value={s}>{s}</option>{/each}
        </select>
      </form>

      <form method="POST" action="?/save" use:enhance class="qedit">
        <select class="chip prio-{t.priority}" name="priority" value={t.priority} onchange={(e) => e.target.form.requestSubmit()} aria-label="Priority">
          {#each [0, 1, 2, 3] as p}<option value={p}>P{p}</option>{/each}
        </select>
      </form>

      {#if t.up_next}<span class="chip chip-up">up next</span>{/if}
      <span class="mono dim det-id">#{t.id}</span>
    </div>

    <form method="POST" action="?/save" use:enhance class="titleform">
      <input class="title-in" name="title" value={t.title} aria-label="Title" />
    </form>

    {#if t.assignee || t.responsible}
      <div class="handoff-trail mono">
        {#if t.assignee}<span class="ht-seg">{@render avatar(t.assignee, 18)} <b style="color:{whoColor(t.assignee)}">{t.assignee}</b> <span class="dim">works it</span></span>{/if}
        {#if t.assignee && t.responsible}<svg class="ht-arr" width="13" height="13"><use href="#i-arrow"/></svg>{/if}
        {#if t.responsible}<span class="ht-seg">{@render avatar(t.responsible, 18)} <b style="color:{whoColor(t.responsible)}">{t.responsible}</b> <span class="dim">responsible</span></span>{/if}
      </div>
    {/if}
  </header>

  {#if t.status === 'doing'}
    <div class="live-bar">
      {#if t.assignee}<span class="agent-badge">{@render avatar(t.assignee, 20)} <span style="color:{whoColor(t.assignee)}">{t.assignee}</span></span>{/if}
      <span class="lb-txt mono">in progress{t.capability ? ` · ${t.capability}` : ''}</span>
    </div>
  {/if}

  <!-- question: the violet one-tap answer UX -->
  {#if t.kind === 'question'}
    {#if data.bodyHtml}<div class="q-context">{@html data.bodyHtml}</div>{/if}

    {#if t.answer}
      <div class="q-done">
        <span class="qd-check"><svg width="20" height="20"><use href="#i-check"/></svg></span>
        <div>
          <div class="qd-title">answered</div>
          <div class="qd-sub mono">→ {data.opts.find((o) => o.value === t.answer)?.label ?? t.answer}</div>
        </div>
      </div>
    {/if}

    {#if data.opts.length}
      <div class="answers" class:locked={t.answer}>
        {#each data.opts as o}
          <form method="POST" action="?/answer" use:enhance>
            <input type="hidden" name="value" value={o.value} />
            <button class="answer" class:on={t.answer === o.value} type="submit">
              <span class="a-dot"></span>
              <span>{o.label}</span>
            </button>
          </form>
        {/each}
      </div>
    {:else}
      <!-- open question (no preset options): free-text answer -->
      <form method="POST" action="?/answer" use:enhance class="freeanswer">
        <textarea name="value" rows="3" placeholder="type your answer…">{t.answer ?? ''}</textarea>
        <button class="q-submit" type="submit">{t.answer ? 'update answer' : 'send answer'}</button>
      </form>
    {/if}
  {/if}

  <!-- doc / idea: rendered prose -->
  {#if isProse && data.bodyHtml}
    <article class="prose">{@html data.bodyHtml}</article>
  {/if}

  <!-- handoff context -->
  {#if t.handoff_context}
    <section class="det-sec">
      <div class="ds-head"><span class="ds-ic"><svg width="12" height="12"><use href="#i-arrow"/></svg></span><h2>handoff context</h2></div>
      <div class="handoff mono">{t.handoff_context}</div>
    </section>
  {/if}

  <!-- worker result -->
  {#if t.result_summary}
    <section class="det-sec">
      <div class="ds-head">
        <span class="ds-ic"><svg width="12" height="12"><use href="#i-check"/></svg></span>
        <h2>worker result</h2>
        <span class="ds-extra"><span class="verif v-{verifClass}">{verif === 'needs_human' ? 'needs human' : verif}</span></span>
      </div>
      <div class="result">{t.result_summary}</div>
    </section>
  {/if}

  <!-- the editable details form (tasks / docs / ideas — questions stay lean) -->
  {#if !isQuestion}
  <form method="POST" action="?/save" use:enhance class="details">
    <input type="hidden" name="vis_touched" value="1" />

    {#if !isProse}
      <section class="det-sec">
        <div class="ds-head"><span class="ds-ic"><svg width="12" height="12"><use href="#i-doc"/></svg></span><h2>plan / notes</h2></div>
        <textarea name="body" rows="8" placeholder="The detailed plan. Drop research here before starting…">{t.body ?? ''}</textarea>
      </section>
    {:else}
      <section class="det-sec">
        <div class="ds-head"><span class="ds-ic"><svg width="12" height="12"><use href="#i-doc"/></svg></span><h2>edit body · markdown</h2></div>
        <textarea name="body" rows="6" class="mono" placeholder="# markdown body…">{t.body ?? ''}</textarea>
      </section>
    {/if}

    {#if !isProse}
      <section class="det-sec">
        <div class="ds-head">
          <span class="ds-ic"><svg width="12" height="12"><use href="#i-check"/></svg></span>
          <h2>acceptance criteria</h2>
          {#if t.result_summary}<span class="ds-extra"><span class="verif v-{verifClass}">{verif === 'needs_human' ? 'needs human' : verif}</span></span>{/if}
        </div>
        <textarea name="acceptance_criteria" rows="3" placeholder="What 'done' means — the mayor verifies against this.">{t.acceptance_criteria ?? ''}</textarea>
      </section>

      <section class="det-sec">
        <div class="ds-head"><span class="ds-ic"><svg width="12" height="12"><use href="#i-block"/></svg></span><h2>blocked on</h2></div>
        {#if t.blocked_on}
          <div class="blk-list">
            <div class="blk-row static"><span class="blk-ic"><svg width="13" height="13"><use href="#i-block"/></svg></span><span class="blk-title">{t.blocked_on}</span></div>
          </div>
        {/if}
        <input name="blocked_on" value={t.blocked_on ?? ''} placeholder="(nothing — what must clear first?)" />
      </section>
    {/if}

    <section class="det-sec">
      <div class="ds-head"><span class="ds-ic"><svg width="12" height="12"><use href="#i-task"/></svg></span><h2>assignment</h2></div>
      <div class="assign-grid">
        <label class="afield">
          <span class="af-lbl">agent · works it next</span>
          <select name="assignee" value={t.assignee ?? ''}>
            <option value="">— none —</option>
            <option value="agent-a">agent-a</option>
            <option value="claude">claude</option>
            <option value="agent-b">agent-b</option>
            <option value="codex">codex</option>
          </select>
        </label>
        <label class="afield">
          <span class="af-lbl">responsible · human</span>
          <select name="responsible" value={t.responsible ?? ''}>
            <option value="">— none —</option>
            <option value="alice">alice</option>
            <option value="bob">bob</option>
          </select>
        </label>
        <label class="afield">
          <span class="af-lbl">capability</span>
          <input name="capability" value={t.capability ?? ''} placeholder="e.g. code · review" />
        </label>
      </div>
    </section>

    <div class="save-bar">
      <label class="chk mono"><input type="checkbox" name="private" checked={t.visibility === 'private'} /> <svg width="12" height="12"><use href="#i-lock"/></svg> private — only you</label>
      <button class="save" type="submit">save changes</button>
    </div>
  </form>
  {/if}

  <!-- sub-tasks -->
  {#if data.kids.length}
    <section class="det-sec">
      <div class="ds-head"><span class="ds-ic"><svg width="12" height="12"><use href="#i-board"/></svg></span><h2>sub-tasks · {data.kids.length}</h2></div>
      <div class="blk-list">
        {#each data.kids as k (k.id)}
          <a class="blk-row kid" href="/task/{k.id}">
            <span class="kid-dot prio-{k.priority}"></span>
            <span class="blk-title">{k.title}</span>
            <span class="chip status-{k.status}">{k.status}</span>
          </a>
        {/each}
      </div>
    </section>
  {/if}

  <!-- coordination log: chat-style -->
  <section class="det-sec">
    <div class="ds-head"><span class="ds-ic"><svg width="12" height="12"><use href="#i-inbox"/></svg></span><h2>coordination log · {data.comments.length}</h2><span class="ds-extra mono dim">plan in the body, findings here</span></div>
    <div class="chat">
      {#each data.comments as c (c.id)}
        {@const author = c.author || 'someone'}
        {@const mine = author === data.me}
        <div class="msg" class:mine>
          {@render avatar(author, 28)}
          <div class="bubble-wrap">
            <div class="msg-meta">
              <b style="color:{whoColor(author)}">{author}</b>
              <span class="chip-mini">{whoKind(author)}</span>
              <span class="mono dim">{ago(c.created_at)}</span>
            </div>
            <div class="bubble">{c.body}</div>
          </div>
        </div>
      {:else}
        <div class="chat-empty">no messages yet — start the thread.</div>
      {/each}
    </div>
    <form method="POST" action="?/comment" use:enhance={() => async ({ update }) => update({ reset: true })} class="chatbar">
      <textarea name="body" rows="1" placeholder="message the thread…"
        onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.target.form.requestSubmit(); } }}></textarea>
      <button class="chat-send" type="submit" title="send"><svg width="18" height="18"><use href="#i-arrow"/></svg></button>
    </form>
  </section>
</div>

<style>
  .screen.detail { max-width: 720px; }

  /* inline chip-selects in the header */
  .qedit { display: contents; }
  .det-meta select.chip {
    appearance: none; -webkit-appearance: none; cursor: pointer; padding-right: 9px;
    border: 1px solid transparent; font-family: var(--mono); font-size: 10px; text-transform: uppercase;
    letter-spacing: .04em; outline: none;
  }
  .det-meta select.chip:hover { filter: brightness(1.15); }
  .chip-up { background: var(--accent-bg); color: var(--accent-b); }

  /* editable title styled as the page h1 */
  .titleform { margin: 0; }
  .title-in {
    width: 100%; background: none; border: none; border-bottom: 1px solid transparent;
    color: var(--text-1); font-family: var(--sans); font-size: 26px; font-weight: 650;
    letter-spacing: -.02em; line-height: 1.2; padding: 2px 0; outline: none;
  }
  .title-in:hover { border-bottom-color: var(--border-sub); }
  .title-in:focus { border-bottom-color: var(--accent-ln); }

  /* handoff trail */
  .handoff-trail { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 13px; font-size: 12px; }
  .ht-seg { display: inline-flex; align-items: center; gap: 7px; }
  .ht-arr { color: var(--text-4); }

  /* question answer options (violet) */
  .answers { display: flex; flex-direction: column; gap: 7px; margin-top: 6px; }
  .answers form { display: contents; }
  .answer {
    display: flex; align-items: center; gap: 11px; width: 100%; text-align: left;
    padding: 13px 15px; background: var(--surface-1); border: 1px solid var(--border-sub);
    border-radius: var(--radius); color: var(--text-2); font: inherit; font-size: 14px; cursor: pointer; transition: .12s;
  }
  .answer:hover { border-color: var(--violet-ln); background: var(--violet-bg); }
  .answer .a-dot { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--border); flex-shrink: 0; position: relative; transition: .1s; }
  .answer.on { border-color: var(--violet); background: var(--violet-bg); color: var(--violet-b); font-weight: 500; }
  .answer.on .a-dot { border-color: var(--violet); }
  .answer.on .a-dot::after { content: ''; position: absolute; inset: 3px; border-radius: 50%; background: var(--violet); }
  .answers.locked .answer:not(.on) { opacity: .55; }

  /* verification chips not in base set */
  .verif.v-verified { background: var(--accent-bg); color: var(--accent-b); }
  .verif.v-rejected { background: rgba(220,38,38,.12); color: var(--danger-b); }

  /* worker result */
  .result {
    font-size: 13.5px; line-height: 1.55; color: var(--text-2); white-space: pre-wrap;
    background: var(--surface-1); border: 1px solid var(--border-sub); border-radius: var(--radius); padding: 12px 14px;
  }

  /* editable form fields (neutral / accent themed) */
  .details textarea, .details input[type=text], .details input:not([type]), .details select {
    width: 100%; font: inherit; font-size: 14px; color: var(--text-1);
    background: var(--surface-1); border: 1px solid var(--border-sub); border-radius: var(--radius);
    padding: 11px 13px; outline: none; resize: vertical;
  }
  .details textarea.mono { font-family: var(--mono); font-size: 13px; }
  .details textarea:focus, .details input:focus, .details select:focus { border-color: var(--accent-ln); background: var(--surface-2); }
  .details select { cursor: pointer; }

  .assign-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
  .afield { display: flex; flex-direction: column; gap: 6px; }
  .af-lbl { font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--text-3); }

  .save-bar {
    display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
    margin-top: 22px; padding-top: 16px; border-top: 1px solid var(--border-sub);
  }
  .chk { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-3); cursor: pointer; }
  .chk input { width: auto; accent-color: var(--accent); }
  .chk svg { color: var(--text-4); }
  .save {
    margin-left: auto; padding: 9px 18px; border-radius: var(--radius);
    background: var(--accent); color: #1a1205; border: none; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; transition: .12s;
  }
  .save:hover { background: var(--accent-b); }

  /* sub-task rows */
  .blk-row.kid { text-decoration: none; cursor: pointer; }
  .blk-row.static { cursor: default; }
  .kid-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .blk-row .chip { margin-left: auto; }

  .det-id { margin-left: auto; }
  .dim { color: var(--text-4); }

  .freeanswer { display: flex; flex-direction: column; gap: 12px; }
  .freeanswer textarea {
    width: 100%; font: inherit; font-size: 14px; color: var(--text-1); resize: vertical;
    background: var(--surface-1); border: 1px solid var(--violet-ln); border-radius: var(--radius); padding: 12px 14px; outline: none;
  }
  .freeanswer textarea:focus { border-color: var(--violet); background: var(--surface-2); }
  .freeanswer .q-submit { align-self: flex-start; padding: 11px 20px; }
</style>
