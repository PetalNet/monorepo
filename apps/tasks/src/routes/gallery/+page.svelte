<script>
  import Icon from '$lib/Icon.svelte';
  let { data } = $props();
  function ago(ts) {
    if (!ts) return '';
    const s = Math.round((Date.now() - new Date(ts.replace(' ', 'T') + 'Z').getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    if (s < 604800) return Math.round(s / 86400) + 'd ago';
    return Math.round(s / 604800) + 'w ago';
  }
</script>

<svelte:head><title>gallery · tasks</title></svelte:head>

<div class="screen gallery">
  <header class="page-head">
    <h1>gallery</h1>
    <p class="ph-sub mono">{data.artifacts.length} page{data.artifacts.length === 1 ? '' : 's'} &amp; writeups · readable in-app behind SSO</p>
  </header>

  {#if data.artifacts.length}
    <div class="cards">
      {#each data.artifacts as a (a.slug)}
        <a class="card" href="/gallery/{a.slug}">
          <span class="card-ic"><Icon name="doc" size={18} /></span>
          <span class="card-main">
            <span class="card-title">{a.title}</span>
            {#if a.description}<span class="card-desc">{a.description}</span>{/if}
            <span class="card-meta mono">
              <span class="kind-tag">{a.kind === 'html' ? 'page' : 'doc'}</span>
              {#if a.visibility === 'private'}<span class="priv"><Icon name="lock" size={11} /> private</span>{/if}
              <span class="dim age">{ago(a.updated_at)}</span>
            </span>
          </span>
          <span class="card-arrow"><Icon name="arrow" size={16} /></span>
        </a>
      {/each}
    </div>
  {:else}
    <p class="empty">No artifacts yet.</p>
  {/if}
</div>

<style>
  .cards { display: flex; flex-direction: column; gap: 10px; margin-top: 8px; }
  .card {
    display: flex; align-items: flex-start; gap: 13px; padding: 15px 16px;
    background: var(--surface-1); border: 1px solid var(--border-sub); border-radius: var(--radius);
    text-decoration: none; transition: border-color .12s, background .12s;
  }
  .card:hover { border-color: var(--accent-ln); background: var(--surface-2); }
  .card-ic { color: var(--accent-b); flex: none; margin-top: 1px; }
  .card-main { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; }
  .card-title { font-size: 15px; font-weight: 600; color: var(--text-1); }
  .card-desc { font-size: 13px; color: var(--text-3); line-height: 1.45; }
  .card-meta { display: flex; align-items: center; gap: 10px; font-size: 11px; margin-top: 2px; }
  .kind-tag { text-transform: uppercase; letter-spacing: .07em; color: var(--text-3); background: var(--surface-2); border: 1px solid var(--border-sub); padding: 1px 7px; border-radius: 5px; }
  .priv { display: inline-flex; align-items: center; gap: 4px; color: var(--text-4); }
  .age { color: var(--text-4); }
  .card-arrow { color: var(--text-4); flex: none; margin-top: 2px; }
  .card:hover .card-arrow { color: var(--accent-b); }
  .empty { color: var(--text-4); font-size: 13px; }
</style>
