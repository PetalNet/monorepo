<script>
  import { enhance } from '$app/forms';
  let { data } = $props();
  let kind = $state('task');
</script>

<svelte:head><title>New · tasks</title></svelte:head>

<div class="wrap">
  <a class="back" href="/">← tasks</a>
  <div class="tabs">
    {#each ['task', 'doc', 'question'] as k}
      <button type="button" class="tab" class:on={kind === k} onclick={() => (kind = k)}>{k}</button>
    {/each}
  </div>

  <form method="POST" action="?/create" use:enhance>
    <input type="hidden" name="kind" value={kind} />
    <input class="title" name="title" autocomplete="off" required
           placeholder={kind === 'question' ? 'The question…' : kind === 'doc' ? 'Doc title…' : 'Task title…'} />

    <label class="lbl">Project</label>
    <input name="project" list="projs" placeholder="(none)" />
    <datalist id="projs">{#each data.projects as p}<option value={p.name}></option>{/each}</datalist>

    {#if kind === 'task'}
      <div class="row">
        <label>Priority
          <select name="priority"><option value="0">P0</option><option value="1">P1</option><option value="2" selected>P2</option><option value="3">P3</option></select>
        </label>
        <label class="chk"><input type="checkbox" name="up_next" /> Up Next</label>
      </div>
      <label class="lbl">Notes / plan</label>
      <textarea name="body" rows="5" placeholder="optional"></textarea>
    {:else if kind === 'doc'}
      <label class="lbl">Body (markdown)</label>
      <textarea name="body" rows="14" placeholder="# Brief / ADR…"></textarea>
    {:else}
      <label class="lbl">Context (markdown)</label>
      <textarea name="body" rows="5" placeholder="background for the decision"></textarea>
      <label class="lbl">Options — one per line ("value | label", or just a label)</label>
      <textarea name="options" rows="4" placeholder={"yes | Yes, do it\nno | No"}></textarea>
    {/if}

    <div><button class="save">Create {kind}</button></div>
  </form>
</div>

<style>
  :global([data-theme=dark]),:global(:root){--bg:#0c0c0d;--surface:#161617;--elev:#1c1c1e;--border:#262628;--border-strong:#34343a;--text:#ededed;--mute:#9a9aa0;--soft:#67676d;--blue:#6f9cff;}
  :global([data-theme=light]){--bg:#fbfbfa;--surface:#fff;--elev:#fff;--border:#ececea;--border-strong:#dcdcd8;--text:#15151a;--mute:#66666c;--soft:#9a9aa0;--blue:#2f5fd0;}
  :global(*){box-sizing:border-box}
  :global(body){margin:0;background:var(--bg);color:var(--text);font-family:'Geist',ui-sans-serif,system-ui,sans-serif;-webkit-font-smoothing:antialiased;}
  .wrap{max-width:680px;margin:0 auto;padding:18px 18px 80px;}
  .back{display:inline-block;color:var(--mute);text-decoration:none;font-size:13px;margin-bottom:16px;}
  .back:hover{color:var(--text);}
  .tabs{display:flex;gap:6px;margin-bottom:16px;}
  .tab{font:inherit;font-size:13px;text-transform:capitalize;border:1px solid var(--border);background:var(--surface);color:var(--mute);border-radius:9px;padding:7px 15px;cursor:pointer;}
  .tab.on{border-color:var(--blue);color:var(--text);}
  .title{width:100%;background:none;border:0;border-bottom:1px solid var(--border);color:var(--text);font:inherit;font-size:20px;font-weight:600;padding:4px 0;outline:0;}
  .title:focus{border-bottom-color:var(--blue);}
  .lbl{display:block;font-size:12px;color:var(--mute);margin:16px 0 5px;text-transform:uppercase;letter-spacing:.03em;}
  input[name=project],textarea,select{width:100%;background:var(--surface);border:1px solid var(--border-strong);border-radius:10px;color:var(--text);font:inherit;font-size:14px;padding:10px 12px;outline:0;resize:vertical;}
  input:focus,textarea:focus,select:focus{border-color:var(--blue);}
  .row{display:flex;gap:18px;align-items:center;margin-top:14px;}
  .row label{font-size:13px;color:var(--mute);}
  .row select{width:auto;margin-left:6px;padding:6px 9px;}
  .chk{display:flex;align-items:center;gap:6px;}.chk input{width:auto;}
  .save{margin-top:18px;background:var(--text);color:var(--bg);border:0;border-radius:9px;font:inherit;font-size:14px;font-weight:500;padding:10px 18px;cursor:pointer;text-transform:capitalize;}
</style>
