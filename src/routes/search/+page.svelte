<script>
  import TaskRow from '$lib/TaskRow.svelte';

  let { data } = $props();
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
      <div class="results">
        {#each data.results as t (t.id)}
          <TaskRow task={t} project={t.project} />
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  /* wide editorial-free column — use the screen (Bob: narrow column wastes space) */
  .wrap { max-width: 1200px; margin: 0 auto; padding: 22px 28px 64px; }

  .hint { margin: 22px 2px; color: var(--text-4); font-size: 14px; }
  .count { margin: 4px 2px 12px; color: var(--text-3); font-size: 13px; }
  .count b { color: var(--text-1); font-weight: 600; }

  /* flat result list — TaskRow draws each row; hairlines separate them */
  .results :global(.trow) + :global(.trow) { border-top: 1px solid var(--border-sub); }
</style>
