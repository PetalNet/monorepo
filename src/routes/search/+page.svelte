<script>
  import Icon from '$lib/Icon.svelte';

  let { data } = $props();

  const KIND = { task: 'task', idea: 'idea', question: 'question', doc: 'doc' };
  const prio = (p) => (p === 0 ? 'P0' : p === 1 ? 'P1' : p === 2 ? 'P2' : 'P3');
  const WHO = { alice: 'Alice', alice: 'Alice', bob: 'Bob', bob: 'Bob', dev: 'dev' };
  const who = (a) => (a ? (WHO[a.toLowerCase()] ?? a) : '');
</script>

<svelte:head><title>{data.q ? `“${data.q}” · search` : 'Search'} · tasks</title></svelte:head>

<div class="wrap">
  {#if !data.q}
    <p class="hint">Use the search bar above to search every task you can see — by title or body.</p>
  {:else}
    <p class="count">{data.results.length}{data.results.length === 60 ? '+' : ''}
      result{data.results.length === 1 ? '' : 's'} for <b>“{data.q}”</b></p>

    {#if data.results.length === 0}
      <p class="hint">No matches. Try fewer or different words.</p>
    {:else}
      <ul class="results">
        {#each data.results as t (t.id)}
          <li>
            <a class="row" class:done={t.status === 'done'} href="/task/{t.id}">
              <span class="st st-{t.status}" title={t.status}></span>
              <span class="body">
                <span class="title">{t.title}</span>
                <span class="meta">
                  <span class="k">{KIND[t.kind] ?? t.kind}</span>
                  {#if t.project}<span class="dot">·</span><span class="proj">{t.project}</span>{/if}
                  {#if t.assignee}<span class="dot">·</span><span class="asg">{who(t.assignee)}</span>{/if}
                  <span class="dot">·</span><span class="status-w">{t.status}</span>
                </span>
              </span>
              {#if t.priority <= 1}<span class="p p{t.priority}">{prio(t.priority)}</span>{/if}
              <Icon name="chevright" size={16} class="go" />
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<style>
  .wrap { max-width: 760px; margin: 0 auto; padding: 22px 20px 64px; }

  .hint { margin: 22px 2px; color: var(--text-4); font-size: 14px; }
  .count { margin: 4px 2px 12px; color: var(--text-3); font-size: 13px; }
  .count b { color: var(--text-1); font-weight: 600; }

  /* flat result rows — dividers, not nested cards */
  .results { list-style: none; margin: 0; padding: 0; }
  .results li + li { border-top: 1px solid var(--border-sub); }
  .row { display: flex; align-items: center; gap: 14px; padding: 19px 12px; text-decoration: none;
    background: none; border: 0; border-radius: var(--radius); transition: background .12s; }
  .row:hover { background: var(--surface-1); }
  .row.done { opacity: .62; }
  .row.done .title { text-decoration: line-through; text-decoration-color: var(--text-4); }

  .st { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: var(--text-4); }
  .st-doing { background: var(--violet); }
  .st-todo { background: var(--info); }
  .st-blocked { background: var(--danger, #e0533d); }
  .st-review { background: var(--warn, #d99a2b); }
  .st-done { background: var(--ok, #3da35d); }
  .st-inbox { background: var(--text-4); }

  .body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .title { font-size: 14.5px; font-weight: 550; color: var(--text-1); line-height: 1.3;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--text-4);
    overflow: hidden; white-space: nowrap; }
  .meta .k { font-family: var(--mono); text-transform: uppercase; letter-spacing: .04em; font-size: 10px; }
  .meta .proj { color: var(--text-3); }
  .meta .dot { opacity: .5; }

  .p { flex-shrink: 0; font-family: var(--mono); font-size: 10.5px; font-weight: 700; padding: 2px 7px;
    border-radius: 999px; }
  .p0 { color: var(--danger, #e0533d); background: color-mix(in srgb, var(--danger, #e0533d) 14%, transparent); }
  .p1 { color: var(--warn, #d99a2b); background: color-mix(in srgb, var(--warn, #d99a2b) 14%, transparent); }
  .row :global(svg.go) { color: var(--text-4); flex-shrink: 0; opacity: 0; transition: opacity .12s; }
  .row:hover :global(svg.go) { opacity: 1; }
</style>
