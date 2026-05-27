<script>
  import { enhance } from '$app/forms';
  let { data } = $props();
  const t = $derived(data.task);
  const projName = (id) => data.projects.find((p) => p.id === id)?.name ?? '';
  const STATUSES = ['inbox', 'todo', 'doing', 'blocked', 'review', 'done', 'dropped'];
  function ago(ts) {
    const d = (Date.now() - new Date(ts.replace(' ', 'T') + 'Z').getTime()) / 1000;
    if (d < 60) return 'just now';
    if (d < 3600) return Math.floor(d / 60) + 'm ago';
    if (d < 86400) return Math.floor(d / 3600) + 'h ago';
    return Math.floor(d / 86400) + 'd ago';
  }
</script>

<svelte:head><title>{t.title} · tasks</title></svelte:head>

<div class="wrap">
  <a class="back" href="/">← tasks</a>

  {#if t.kind === 'question'}
    <section class="qbox">
      {#if data.bodyHtml}<div class="md">{@html data.bodyHtml}</div>{/if}
      <div class="opts">
        {#each data.opts as o}
          <form method="POST" action="?/answer" use:enhance>
            <input type="hidden" name="value" value={o.value} />
            <button class="opt" class:chosen={t.answer === o.value}>{o.label}</button>
          </form>
        {/each}
      </div>
      {#if t.answer}<div class="answered">Answered: <b>{data.opts.find((o) => o.value === t.answer)?.label ?? t.answer}</b></div>{/if}
    </section>
  {:else if t.kind === 'doc' && data.bodyHtml}
    <div class="md">{@html data.bodyHtml}</div>
  {/if}

  <form method="POST" action="?/save" use:enhance>
    <input class="title" name="title" value={t.title} />
    <div class="row">
      <select name="status" value={t.status}>{#each STATUSES as s}<option value={s}>{s}</option>{/each}</select>
      <select name="priority" value={t.priority}>{#each [0, 1, 2, 3] as p}<option value={p}>P{p}</option>{/each}</select>
      {#if projName(t.project_id)}<span class="tag">{projName(t.project_id)}</span>{/if}
      {#if t.up_next}<span class="tag up">up next</span>{/if}
    </div>
    <label class="lbl">Plan / notes</label>
    <textarea name="body" rows="8" placeholder="The detailed plan. Drop research here before starting…">{t.body ?? ''}</textarea>
    <div class="row two">
      <label>Agent (works it next)
        <select name="assignee" value={t.assignee ?? ''}>
          <option value="">— none —</option>
          <option value="agent-a">agent-a</option>
          <option value="claude">claude</option>
          <option value="codex">codex</option>
        </select>
      </label>
      <label>Responsible (human)
        <select name="responsible" value={t.responsible ?? ''}>
          <option value="">— none —</option>
          <option value="alice">alice</option>
          <option value="bob">bob</option>
        </select>
      </label>
    </div>
    <label class="lbl">Acceptance criteria</label>
    <textarea name="acceptance_criteria" rows="2" placeholder="What 'done' means — the mayor verifies against this.">{t.acceptance_criteria ?? ''}</textarea>
    <label class="lbl">Blocked on</label>
    <input name="blocked_on" value={t.blocked_on ?? ''} placeholder="(nothing)" />
    {#if t.result_summary}
      <label class="lbl">Worker result{#if t.verification_status && t.verification_status !== 'unverified'} · <span class="vs {t.verification_status}">{t.verification_status}</span>{/if}</label>
      <div class="result">{t.result_summary}</div>
    {/if}
    <label class="chk"><input type="checkbox" name="private" checked={t.visibility === 'private'} /> Private — only you can see it</label>
    <div><button class="save">Save</button></div>
  </form>

  {#if data.kids.length}
    <section>
      <h3>Sub-tasks</h3>
      {#each data.kids as k (k.id)}
        <a class="kid" href="/task/{k.id}"><span class="dot p{k.priority}"></span>{k.title}<span class="st">{k.status}</span></a>
      {/each}
    </section>
  {/if}

  <section>
    <h3>Coordination log <span class="muted">— plan in the body, findings here</span></h3>
    {#each data.comments as c (c.id)}
      <div class="cmt"><div class="cmt-h mono">{c.author || 'someone'} · {ago(c.created_at)}</div><div class="cmt-b">{c.body}</div></div>
    {:else}
      <p class="muted">No notes yet.</p>
    {/each}
    <form method="POST" action="?/comment" use:enhance={() => async ({ update }) => update({ reset: true })}>
      <textarea name="body" rows="2" placeholder="Add a note / finding…"></textarea>
      <div><button class="save">Add note</button></div>
    </form>
  </section>
</div>

<style>
  :global([data-theme=dark]),:global(:root){--bg:#0c0c0d;--surface:#161617;--elev:#1c1c1e;--border:#262628;--border-strong:#34343a;--text:#ededed;--mute:#9a9aa0;--soft:#67676d;--green:#2bd576;--amber:#e0a93a;--red:#e05a5a;--blue:#6f9cff;}
  :global([data-theme=light]){--bg:#fbfbfa;--surface:#fff;--elev:#fff;--border:#ececea;--border-strong:#dcdcd8;--text:#15151a;--mute:#66666c;--soft:#9a9aa0;--green:#1f9d57;--amber:#b9842a;--red:#c44;--blue:#2f5fd0;}
  :global(*){box-sizing:border-box}
  :global(body){margin:0;background:var(--bg);color:var(--text);font-family:'Geist',ui-sans-serif,system-ui,sans-serif;-webkit-font-smoothing:antialiased;}
  .mono{font-family:'Geist Mono',ui-monospace,monospace;}
  .wrap{max-width:680px;margin:0 auto;padding:18px 18px 80px;}
  .back{display:inline-block;color:var(--mute);text-decoration:none;font-size:13px;margin-bottom:16px;}
  .back:hover{color:var(--text);}
  .title{width:100%;background:none;border:0;border-bottom:1px solid transparent;color:var(--text);font:inherit;font-size:22px;font-weight:600;letter-spacing:-.02em;padding:2px 0;outline:0;}
  .title:hover,.title:focus{border-bottom-color:var(--border);}
  .row{display:flex;align-items:center;gap:8px;margin:12px 0;flex-wrap:wrap;}
  .row select{background:var(--surface);border:1px solid var(--border);border-radius:8px;color:var(--text);font:inherit;font-size:13px;padding:6px 9px;cursor:pointer;}
  .row.two{align-items:flex-start;}
  .row.two label{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--mute);text-transform:uppercase;letter-spacing:.03em;}
  .row.two select{min-width:150px;}
  .tag{font-family:'Geist Mono',ui-monospace,monospace;font-size:11px;color:var(--mute);background:var(--elev);border:1px solid var(--border);border-radius:5px;padding:3px 7px;}
  .tag.up{color:var(--green);}
  .lbl{display:block;font-size:12px;color:var(--mute);margin:14px 0 5px;text-transform:uppercase;letter-spacing:.03em;}
  textarea,input[name=blocked_on]{width:100%;background:var(--surface);border:1px solid var(--border-strong);border-radius:10px;color:var(--text);font:inherit;font-size:14px;padding:10px 12px;outline:0;resize:vertical;}
  textarea:focus,input:focus{border-color:var(--blue);}
  .save{margin-top:10px;background:var(--text);color:var(--bg);border:0;border-radius:9px;font:inherit;font-size:13px;font-weight:500;padding:8px 16px;cursor:pointer;}
  .chk{display:flex;align-items:center;gap:7px;margin-top:16px;font-size:13px;color:var(--mute);}.chk input{width:auto;}
  section{margin-top:30px;border-top:1px solid var(--border);padding-top:18px;}
  h3{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.02em;color:var(--mute);margin:0 0 12px;}
  .muted{color:var(--soft);font-weight:400;text-transform:none;letter-spacing:0;font-size:12px;}
  .kid{display:flex;align-items:center;gap:9px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;margin-bottom:7px;text-decoration:none;color:var(--text);font-size:14px;}
  .kid:hover{border-color:var(--border-strong);}
  .kid .st{margin-left:auto;font-family:'Geist Mono',ui-monospace,monospace;font-size:11px;color:var(--soft);}
  .dot{width:7px;height:7px;border-radius:50%;flex:none;}
  .p0{background:var(--red)}.p1{background:var(--amber)}.p2{background:var(--blue)}.p3{background:var(--soft)}
  .cmt{padding:10px 0;border-bottom:1px solid var(--border);}
  .cmt-h{font-size:11.5px;color:var(--soft);margin-bottom:4px;}
  .cmt-b{font-size:14px;line-height:1.45;white-space:pre-wrap;}
  .result{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px 12px;font-size:14px;line-height:1.45;white-space:pre-wrap;}
  .vs{font-family:'Geist Mono',ui-monospace,monospace;font-size:11px;}
  .vs.verified{color:var(--green);}.vs.rejected{color:var(--red);}
  .qbox{margin-bottom:18px;}
  .opts{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0;}
  .opt{border:1px solid var(--border-strong);background:var(--elev);color:var(--text);border-radius:8px;padding:7px 13px;cursor:pointer;font:inherit;font-size:13px;}
  .opt:hover{border-color:var(--blue);color:var(--blue);}
  .opt.chosen{background:var(--green);color:var(--bg);border-color:var(--green);}
  .answered{font-size:13px;color:var(--mute);}
  .md{font-size:14.5px;line-height:1.6;}
  .md :global(h1),.md :global(h2),.md :global(h3){line-height:1.25;}
  .md :global(code){font-family:'Geist Mono',ui-monospace,monospace;font-size:.9em;background:var(--elev);border:1px solid var(--border);border-radius:4px;padding:1px 5px;}
  .md :global(pre){background:var(--elev);border:1px solid var(--border);border-radius:9px;padding:12px;overflow:auto;}
  .md :global(pre code){border:0;padding:0;background:none;}
  .md :global(a){color:var(--blue);}
  .md :global(ul),.md :global(ol){padding-left:22px;}
</style>
