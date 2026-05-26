<script>
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';

  let { data } = $props();
  let openSub = $state({}); // which task ids have their "+ sub" input open

  const projName = (id) => data.projects.find((p) => p.id === id)?.name ?? '';

  function ago(ts) {
    const d = (Date.now() - new Date(ts.replace(' ', 'T') + 'Z').getTime()) / 1000;
    if (d < 60) return 'just now';
    if (d < 3600) return Math.floor(d / 60) + 'm ago';
    if (d < 86400) return Math.floor(d / 3600) + 'h ago';
    return Math.floor(d / 86400) + 'd ago';
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('tasks-theme', next); } catch {}
  }

  function pickProject(e) {
    const v = e.target.value;
    goto(v ? `?project=${encodeURIComponent(v)}` : '?', { keepFocus: true, noScroll: true });
  }
</script>

<svelte:head><title>tasks{data.current ? ' · ' + data.current : ''}</title></svelte:head>

<svg width="0" height="0" style="position:absolute"><defs>
  <symbol id="i-mark" viewBox="0 0 32 32"><rect x="3.5" y="3.5" width="25" height="25" rx="6" stroke="currentColor" stroke-width="1.4" fill="none"/><rect x="10" y="10" width="12" height="12" rx="2.5" fill="currentColor"/></symbol>
  <symbol id="i-plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></symbol>
  <symbol id="i-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></symbol>
  <symbol id="i-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M20 14a8 8 0 1 1-10-10 6.5 6.5 0 0 0 10 10z"/></symbol>
  <symbol id="i-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"/></symbol>
</defs></svg>

<!-- one task + its sub-tasks, nested recursively (work isn't flat) -->
{#snippet row(t, depth)}
  <div class="item" class:sub={depth > 0}>
    <form method="POST" action="?/update" use:enhance>
      <input type="hidden" name="id" value={t.id} /><input type="hidden" name="status" value="done" />
      <button class="box" title="Complete"><svg class="chk ic"><use href="#i-check"/></svg></button>
    </form>
    <div class="body">
      <a class="ttl" href="/task/{t.id}">{t.title}</a>
      <div class="meta">
        <span class="dot p{t.priority}"></span>P{t.priority}
        {#if projName(t.project_id)}<span class="tag">{projName(t.project_id)}</span>{/if}
        {#if t.blocked_on}<span class="blocked">· blocked: {t.blocked_on}</span>{/if}
        <button type="button" class="link" onclick={() => (openSub[t.id] = !openSub[t.id])}>+ sub</button>
      </div>
      {#if openSub[t.id]}
        <form class="subadd" method="POST" action="?/subtask"
              use:enhance={() => async ({ update }) => { openSub[t.id] = false; await update({ reset: true }); }}>
          <input type="hidden" name="parent" value={t.id} />
          <input name="title" placeholder="Break it down…" autocomplete="off" />
        </form>
      {/if}
    </div>
    {#if !t.up_next}
      <form method="POST" action="?/update" use:enhance class="bump">
        <input type="hidden" name="id" value={t.id} /><input type="hidden" name="up_next" value="1" />
        <button class="tg" title="Move to Up Next">↑</button>
      </form>
    {/if}
  </div>
  {#each t.kids ?? [] as k (k.id)}{@render row(k, depth + 1)}{/each}
{/snippet}

<div class="wrap">
  <header class="bar">
    <a class="logo" href="?"><svg class="mk ic"><use href="#i-mark"/></svg>tasks</a>
    <div class="proj">
      {#if data.current}<svg class="lock ic"><use href="#i-lock"/></svg>{/if}
      <select onchange={pickProject} value={data.current ?? ''} aria-label="Project">
        <option value="">All projects</option>
        {#each data.projects as p}<option value={p.name}>{p.name}</option>{/each}
      </select>
    </div>
    <span class="spacer"></span>
    <button class="ico" onclick={toggleTheme} title="Theme"><svg class="ic"><use href="#i-moon"/></svg></button>
  </header>

  <form class="capture" method="POST" action="?/capture" use:enhance={() => ({ update }) => update({ reset: true })}>
    <svg><use href="#i-plus"/></svg>
    <input name="title" placeholder="Capture an idea or task…" autocomplete="off" />
    {#if data.current}<input type="hidden" name="project" value={data.current} />{/if}
    <kbd>↵</kbd>
  </form>

  <!-- QUESTIONS — async decisions (merged from Claude Corner) -->
  {#if data.questions.length}
    <section class="sec">
      <div class="sec-h"><h2>Questions</h2><span class="count">{data.questions.length}</span></div>
      {#each data.questions as q (q.id)}
        <div class="item q">
          <div class="body">
            <a class="ttl" href="/task/{q.id}">{q.title}</a>
            <div class="opts">
              {#each q.opts as o}
                <form method="POST" action="?/answer" use:enhance>
                  <input type="hidden" name="id" value={q.id} /><input type="hidden" name="value" value={o.value} />
                  <button class="opt">{o.label}</button>
                </form>
              {/each}
            </div>
          </div>
        </div>
      {/each}
    </section>
  {/if}

  <!-- UP NEXT — manual rank order ("do this then that") -->
  <section class="sec">
    <div class="sec-h"><h2>Up Next</h2><span class="count">{data.upNext.length}</span></div>
    {#each data.upNext as t (t.id)}{@render row(t, 0)}{:else}<p class="empty">Nothing queued. Triage an idea up here.</p>{/each}
  </section>

  <!-- INBOX — raw idea capture awaiting triage -->
  <section class="sec">
    <div class="sec-h"><h2>Inbox</h2><span class="count">{data.inbox.length}</span></div>
    {#each data.inbox as t (t.id)}
      <div class="item idea">
        <div class="body">
          <a class="ttl" href="/task/{t.id}">{t.title}</a>
          <div class="meta mono">captured {ago(t.created_at)}{t.created_by ? ' · ' + t.created_by : ''}</div>
        </div>
        <div class="triage">
          <form method="POST" action="?/triage" use:enhance><input type="hidden" name="id" value={t.id}/><input type="hidden" name="to" value="up"/><button class="tg up">↑ Up Next</button></form>
          <form method="POST" action="?/triage" use:enhance><input type="hidden" name="id" value={t.id}/><input type="hidden" name="to" value="project"/><input type="hidden" name="name" value={t.title}/><button class="tg">→ Project</button></form>
          <form method="POST" action="?/triage" use:enhance><input type="hidden" name="id" value={t.id}/><input type="hidden" name="to" value="backlog"/><button class="tg">Backlog</button></form>
          <form method="POST" action="?/triage" use:enhance><input type="hidden" name="id" value={t.id}/><input type="hidden" name="to" value="drop"/><button class="tg" title="Dismiss">✕</button></form>
        </div>
      </div>
    {:else}
      <p class="empty">Inbox zero.</p>
    {/each}
  </section>

  <!-- BACKLOG -->
  <section class="sec">
    <div class="sec-h"><h2>Backlog</h2><span class="count">{data.backlog.length}</span></div>
    {#each data.backlog as t (t.id)}{@render row(t, 0)}{:else}<p class="empty">Backlog clear.</p>{/each}
  </section>

  <!-- DOCS — briefs / ADRs (merged from Claude Corner) -->
  {#if data.docs.length}
    <section class="sec">
      <div class="sec-h"><h2>Docs</h2><span class="count">{data.docs.length}</span></div>
      {#each data.docs as d (d.id)}
        <a class="docrow" href="/task/{d.id}">
          <span class="ttl">{d.title}</span>
          {#if projName(d.project_id)}<span class="tag">{projName(d.project_id)}</span>{/if}
        </a>
      {/each}
    </section>
  {/if}

  <div class="foot mono">SQLite-backed · tasks · docs · questions · agents</div>
</div>

<style>
  :global(:root),:global([data-theme=dark]){--bg:#0c0c0d;--surface:#161617;--elev:#1c1c1e;--border:#262628;--border-strong:#34343a;--text:#ededed;--mute:#9a9aa0;--soft:#67676d;--green:#2bd576;--amber:#e0a93a;--red:#e05a5a;--blue:#6f9cff;}
  :global([data-theme=light]){--bg:#fbfbfa;--surface:#fff;--elev:#fff;--border:#ececea;--border-strong:#dcdcd8;--text:#15151a;--mute:#66666c;--soft:#9a9aa0;--green:#1f9d57;--amber:#b9842a;--red:#c44;--blue:#2f5fd0;}
  :global(*){box-sizing:border-box}
  :global(body){margin:0;background:var(--bg);color:var(--text);font-family:'Geist',ui-sans-serif,system-ui,sans-serif;-webkit-font-smoothing:antialiased;}
  .mono{font-family:'Geist Mono',ui-monospace,monospace;}
  svg.ic{width:100%;height:100%;display:block;}
  .wrap{max-width:680px;margin:0 auto;padding:0 18px 80px;}

  .bar{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:12px;height:60px;background:color-mix(in srgb,var(--bg) 86%,transparent);backdrop-filter:blur(10px);}
  .logo{display:flex;align-items:center;gap:8px;font-weight:600;font-size:16px;letter-spacing:-.02em;text-decoration:none;color:var(--text);}
  .logo .mk{width:22px;height:22px;}
  .proj{margin-left:4px;display:flex;align-items:center;gap:6px;background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:0 4px 0 10px;}
  .proj .lock{color:var(--soft);width:13px;height:13px;flex:none;}
  .proj select{border:0;background:none;color:var(--text);font:inherit;font-size:13.5px;padding:7px 4px;cursor:pointer;outline:0;}
  .spacer{flex:1}
  .ico{width:34px;height:34px;padding:7px;border-radius:8px;border:0;background:none;color:var(--mute);cursor:pointer;}.ico:hover{background:var(--surface);color:var(--text);}

  .capture{display:flex;align-items:center;gap:10px;background:var(--surface);border:1px solid var(--border-strong);border-radius:13px;padding:0 12px;height:50px;margin:6px 0 26px;}
  .capture svg{width:18px;height:18px;color:var(--soft);flex:none;}
  .capture input{flex:1;border:0;background:none;outline:0;color:var(--text);font:inherit;font-size:15.5px;}
  .capture kbd{font-family:'Geist Mono',ui-monospace,monospace;font-size:11px;color:var(--soft);border:1px solid var(--border);border-radius:5px;padding:2px 6px;}

  .sec{margin-bottom:26px;}
  .sec-h{display:flex;align-items:center;gap:9px;margin:0 2px 11px;}
  .sec-h h2{font-size:13px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:var(--mute);margin:0;}
  .sec-h .count{font-family:'Geist Mono',ui-monospace,monospace;font-size:12px;color:var(--soft);}
  .empty{color:var(--soft);font-size:13px;margin:2px;}
  .item.q{border-color:var(--border-strong);}
  .q .opts{display:flex;flex-wrap:wrap;gap:7px;margin-top:10px;}
  .opt{font-size:13px;border:1px solid var(--border-strong);background:var(--elev);color:var(--text);border-radius:8px;padding:6px 12px;cursor:pointer;font:inherit;font-size:13px;}
  .opt:hover{border-color:var(--blue);color:var(--blue);}
  .docrow{display:flex;align-items:center;gap:9px;padding:11px 13px;border:1px solid var(--border);border-radius:11px;background:var(--surface);margin-bottom:8px;text-decoration:none;}
  .docrow:hover{border-color:var(--border-strong);}
  .docrow .ttl{flex:1;}

  .item{display:flex;align-items:flex-start;gap:11px;padding:12px 13px;border-radius:11px;border:1px solid var(--border);background:var(--surface);margin-bottom:8px;}
  .item:hover{border-color:var(--border-strong);}
  .box{width:20px;height:20px;border-radius:6px;border:1.6px solid var(--border-strong);flex:none;margin-top:1px;cursor:pointer;background:none;color:transparent;padding:1px;}
  .box:hover{border-color:var(--green);color:var(--green);}
  .body{flex:1;min-width:0;}
  .ttl{display:block;font-size:14.5px;line-height:1.35;color:var(--text);text-decoration:none;}
  .ttl:hover{text-decoration:underline;text-underline-offset:2px;}
  .meta{display:flex;align-items:center;gap:7px;margin-top:5px;font-size:12px;color:var(--soft);}
  .dot{width:7px;height:7px;border-radius:50%;flex:none;}
  .p0{background:var(--red)}.p1{background:var(--amber)}.p2{background:var(--blue)}.p3{background:var(--soft)}
  .tag{font-family:'Geist Mono',ui-monospace,monospace;font-size:11px;color:var(--mute);background:var(--elev);border:1px solid var(--border);border-radius:5px;padding:1px 6px;}
  .blocked{color:var(--amber);}

  .idea{border-style:dashed;}
  .triage{display:flex;gap:6px;flex:none;align-self:center;}
  .tg{font-size:12px;border:1px solid var(--border);background:var(--elev);color:var(--mute);border-radius:7px;padding:5px 9px;cursor:pointer;white-space:nowrap;}
  .tg:hover{color:var(--text);border-color:var(--border-strong);}
  .tg.up{color:var(--green);}
  .bump{align-self:center;}.bump .tg{padding:5px 8px;}
  .item.sub{margin-left:26px;border-style:dashed;}
  .link{background:none;border:0;color:var(--soft);font:inherit;font-size:11.5px;cursor:pointer;padding:0;text-decoration:underline;text-underline-offset:2px;}
  .link:hover{color:var(--text);}
  .subadd{margin-top:7px;}
  .subadd input{width:100%;background:var(--elev);border:1px solid var(--border);border-radius:7px;color:var(--text);font:inherit;font-size:13px;padding:6px 9px;outline:0;}

  .foot{color:var(--soft);font-size:12px;text-align:center;margin-top:30px;}
  @media(max-width:540px){ .triage form:not(:first-child) .tg{display:none;} .item{padding:11px;} }
</style>
