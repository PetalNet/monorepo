<script>
  import { enhance } from '$app/forms';
  let { data } = $props();
</script>

<svelte:head><title>Projects · tasks</title></svelte:head>

<div class="wrap">
  <a class="back" href="/">← tasks</a>
  <h1>Projects</h1>
  {#each data.projects as p (p.id)}
    <div class="proj">
      <form method="POST" action="?/rename" use:enhance class="ren">
        <input type="hidden" name="id" value={p.id} />
        <input class="name" name="name" value={p.name} aria-label="Project name" />
      </form>
      <span class="count" title="active items">{p.count}</span>
      <form method="POST" action="?/visibility" use:enhance>
        <input type="hidden" name="id" value={p.id} />
        <label class="chk"><input type="checkbox" name="private" checked={p.visibility === 'private'} onchange={(e) => e.target.form.requestSubmit()} /> private</label>
      </form>
      <form method="POST" action="?/delete" use:enhance>
        <input type="hidden" name="id" value={p.id} />
        <button class="del" onclick={(e) => { if (!confirm(`Delete "${p.name}" and all its items?`)) e.preventDefault(); }}>Delete</button>
      </form>
    </div>
  {:else}
    <p class="empty">No projects yet.</p>
  {/each}
</div>

<style>
  :global([data-theme=dark]),:global(:root){--bg:#0c0c0d;--surface:#161617;--elev:#1c1c1e;--border:#262628;--border-strong:#34343a;--text:#ededed;--mute:#9a9aa0;--soft:#67676d;--red:#e05a5a;--blue:#6f9cff;}
  :global([data-theme=light]){--bg:#fbfbfa;--surface:#fff;--elev:#fff;--border:#ececea;--border-strong:#dcdcd8;--text:#15151a;--mute:#66666c;--soft:#9a9aa0;--red:#c44;--blue:#2f5fd0;}
  :global(*){box-sizing:border-box}
  :global(body){margin:0;background:var(--bg);color:var(--text);font-family:'Geist',ui-sans-serif,system-ui,sans-serif;-webkit-font-smoothing:antialiased;}
  .wrap{max-width:680px;margin:0 auto;padding:18px 18px 80px;}
  .back{display:inline-block;color:var(--mute);text-decoration:none;font-size:13px;margin-bottom:10px;}.back:hover{color:var(--text);}
  h1{font-size:20px;font-weight:600;letter-spacing:-.02em;margin:0 0 16px;}
  .proj{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--border);}
  .ren{flex:1;}
  .name{width:100%;background:none;border:1px solid transparent;border-radius:7px;color:var(--text);font:inherit;font-size:14.5px;padding:5px 7px;outline:0;}
  .name:hover{border-color:var(--border);}.name:focus{border-color:var(--blue);background:var(--surface);}
  .count{font-family:'Geist Mono',ui-monospace,monospace;font-size:12px;color:var(--soft);min-width:20px;text-align:right;}
  .chk{display:flex;align-items:center;gap:5px;font-size:12px;color:var(--mute);}.chk input{width:auto;}
  .del{font:inherit;font-size:12px;color:var(--soft);background:none;border:1px solid var(--border);border-radius:7px;padding:5px 10px;cursor:pointer;}
  .del:hover{color:var(--red);border-color:var(--red);}
  .empty{color:var(--soft);font-size:13px;}
</style>
