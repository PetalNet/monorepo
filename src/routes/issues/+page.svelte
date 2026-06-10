<script>
  let { data } = $props();
  let tab = $state('open');

  const PERSON = { claude:'#fb923c', agent-a:'#8b5cf6', agent-b:'#22d3ee', alice:'#fb7185', alice:'#fb7185', bob:'#38bdf8', bob:'#38bdf8', codex:'#a3e635', agent-d:'#f472b6', agent-e:'#facc15', web:'#94a3b8' };
  const AGENTS = ['claude', 'agent-a', 'agent-b', 'codex', 'agent-d', 'agent-e'];
  const hue = (s) => { let h = 0; for (let i = 0; i < (s?.length ?? 0); i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; };
  const whoColor = (h) => h ? (PERSON[String(h).toLowerCase()] ?? `hsl(${hue(h)} 60% 68%)`) : 'var(--text-3)';
  const isAgent = (h) => AGENTS.includes(String(h).toLowerCase());
  const projName = (id) => data.projects.find((p) => p.id === id)?.name ?? '';

  function relShort(ts) {
    if (!ts) return '';
    const s = Math.round((Date.now() - new Date(ts.replace(' ', 'T') + 'Z').getTime()) / 1000);
    if (s < 60) return s + 's';
    if (s < 3600) return Math.round(s / 60) + 'm';
    if (s < 86400) return Math.round(s / 3600) + 'h';
    if (s < 604800) return Math.round(s / 86400) + 'd';
    return Math.round(s / 604800) + 'w';
  }
  const labelHue = (t) => Math.abs([...t].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)) % 360;

  const list = $derived(tab === 'open' ? data.open : data.closed);
</script>

<svelte:head><title>issues · tasks</title></svelte:head>

{#snippet avatar(handle, size)}
  {@const c = whoColor(handle)}
  {@const ag = isAgent(handle)}
  <span class="avatar" style="width:{size}px;height:{size}px;font-size:{Math.round(size * 0.42)}px;color:{c};border-color:{c};background:{ag ? 'transparent' : c + '22'};border-style:{ag ? 'dashed' : 'solid'}">{(handle || '?').charAt(0).toLowerCase()}</span>
{/snippet}

<div class="screen issues">
  <header class="page-head">
    <h1>issues</h1>
    <p class="ph-sub mono">{data.open.length} open · {data.closed.length} closed · {data.projectCount} projects</p>
  </header>

  <div class="iss-list">
    <div class="iss-tabs">
      <button class:on={tab === 'open'} onclick={() => (tab = 'open')}><svg width="15" height="15" aria-hidden="true"><use href="#i-iopen"/></svg> {data.open.length} Open</button>
      <button class:on={tab === 'closed'} onclick={() => (tab = 'closed')}><svg width="15" height="15" aria-hidden="true"><use href="#i-iclosed"/></svg> {data.closed.length} Closed</button>
    </div>

    {#each list as it (it.id)}
      {@const closed = it.status === 'done' || it.status === 'dropped'}
      {@const author = it.created_by || it.responsible || it.assignee}
      <a class="iss-row" href="/task/{it.id}">
        <span class="iss-ic {closed ? 'closed' : 'open'}"><svg width="17" height="17" aria-hidden="true"><use href="#i-{closed ? 'iclosed' : 'iopen'}"/></svg></span>
        <span class="iss-main">
          <span class="iss-title-row">
            <span class="iss-title">{it.title}</span>
            {#if it.kind === 'question'}<span class="iss-label" style="--h:142">question</span>{/if}
            {#if it.kind === 'idea'}<span class="iss-label" style="--h:48">idea</span>{/if}
            {#if it.up_next}<span class="iss-label" style="--h:32">up next</span>{/if}
            {#if it.priority <= 1}<span class="iss-label" style="--h:2">priority</span>{/if}
            {#if projName(it.project_id)}<span class="iss-label" style="--h:{labelHue(projName(it.project_id))}">{projName(it.project_id)}</span>{/if}
          </span>
          <span class="iss-meta mono">
            #{it.id} · {closed ? 'closed' : 'opened'} {relShort(it.updated_at || it.created_at)} ago{#if author}&nbsp;by&nbsp;<b style="color:{whoColor(author)}">{author}</b>{/if}
          </span>
        </span>
        <span class="iss-right">
          {#if it.assignee}{@render avatar(it.assignee, 20)}{/if}
          {#if it.ncomments > 0}<span class="iss-comments"><svg width="13" height="13" aria-hidden="true"><use href="#i-comment"/></svg> {it.ncomments}</span>{/if}
        </span>
      </a>
    {:else}
      <div class="iss-empty">no {tab} issues.</div>
    {/each}
  </div>
</div>
