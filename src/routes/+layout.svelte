<script>
  import '../app.css';
  import { page } from '$app/stores';
  let { children, data } = $props();

  // nav (only routes that exist today; inbox/issues come with their screens)
  const nav = [
    { name: 'board', label: 'board', icon: 'board', href: '/' },
    { name: 'inbox', label: 'inbox', icon: 'inbox', href: '/inbox' },
    { name: 'issues', label: 'issues', icon: 'iopen', href: '/issues' },
    { name: 'projects', label: 'projects', icon: 'projects', href: '/projects' },
    { name: 'new', label: 'new', icon: 'plus', href: '/new' }
  ];
  const active = (n) => {
    const p = $page.url.pathname;
    if (n === 'projects') return p.startsWith('/projects');
    if (n === 'inbox') return p.startsWith('/inbox');
    if (n === 'issues') return p.startsWith('/issues');
    if (n === 'new') return p.startsWith('/new');
    if (n === 'board') return p === '/' || p.startsWith('/task');
    return false;
  };

  // agent activity rail — live-wired to in-progress leases (data.activeAgents)
  const KNOWN = [
    { h: 'claude', color: '#fb923c', cap: 'code · review' },
    { h: 'agent-a', color: '#8b5cf6', cap: 'orchestrate · ops' },
    { h: 'agent-b', color: '#22d3ee', cap: 'research' }
  ];
  const EXTRA_CAP = { codex: 'deep code', agent-d: 'updates', agent-e: 'relay' };
  const EXTRA_COLOR = { codex: '#a3e635', agent-d: '#f472b6', agent-e: '#facc15' };
  const agents = $derived.by(() => {
    const active = data?.activeAgents ?? {};
    const list = KNOWN.map((a) => ({ ...a, name: a.h, tasks: active[a.h] ?? [] }));
    for (const h of Object.keys(active)) {
      if (!KNOWN.some((a) => a.h === h)) list.push({ h, name: h, color: EXTRA_COLOR[h] ?? '#94a3b8', cap: EXTRA_CAP[h] ?? 'agent', tasks: active[h] });
    }
    // working agents first
    return list.sort((a, b) => b.tasks.length - a.tasks.length);
  });
  const anyWorking = $derived(agents.some((a) => a.tasks.length));

  // live agent-fleet heartbeat (sessions / workflows / subagents) — staleness-aware
  const fleet = $derived(data?.fleet ?? null);
  const fleetAge = $derived(
    fleet?.updated_at ? Math.max(0, Math.round((Date.now() - new Date(fleet.updated_at).getTime()) / 60000)) : null
  );
  const fleetFresh = $derived(fleetAge != null && fleetAge <= 10);

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('tasks-theme', next); } catch {}
  }
</script>

<!-- shared icon set (used by the shell + every page) -->
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <symbol id="i-board" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="6" height="16" rx="1.5"/><rect x="11" y="4" width="6" height="10" rx="1.5"/><rect x="19" y="4" width="2" height="13" rx="1"/></symbol>
  <symbol id="i-projects" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h6l2 2h8v10H4z"/></symbol>
  <symbol id="i-inbox" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13h4l1.5 3h5L16 13h4"/><path d="M4 13 6 5h12l2 8v6H4z"/></symbol>
  <symbol id="i-task" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="m9 12 2 2 4-4"/></symbol>
  <symbol id="i-question" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 .9-1 1.7"/><path d="M12 17h.01"/></symbol>
  <symbol id="i-doc" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 16h6"/></symbol>
  <symbol id="i-idea" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-4 10.5c.6.6 1 1.5 1 2.5h6c0-1 .4-1.9 1-2.5A6 6 0 0 0 12 3Z"/></symbol>
  <symbol id="i-bolt" viewBox="0 0 24 24"><path d="M13 3 5 13h6l-1 8 8-10h-6z" fill="currentColor"/></symbol>
  <symbol id="i-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></symbol>
  <symbol id="i-block" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m6 6 12 12"/></symbol>
  <symbol id="i-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></symbol>
  <symbol id="i-plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></symbol>
  <symbol id="i-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></symbol>
  <symbol id="i-sticky" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h14v10l-5 5H5z"/><path d="M19 14h-5v5"/></symbol>
  <symbol id="i-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M20 14a8 8 0 1 1-10-10 6.5 6.5 0 0 0 10 10z"/></symbol>
  <symbol id="i-iopen" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none"/></symbol>
  <symbol id="i-iclosed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.4 2.4 4.6-4.8"/></symbol>
  <symbol id="i-comment" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5h14v11H9l-4 3z"/></symbol>
</defs></svg>

<div class="app">
  <aside class="sidebar">
    <a class="brand" href="/"><span class="brand-dot"></span><span class="brand-name">tasks</span></a>
    <nav class="snav">
      {#each nav as n}
        <a class="snav-item" class:on={active(n.name)} href={n.href}>
          <svg width="17" height="17"><use href="#i-{n.icon}"/></svg><span>{n.label}</span>
        </a>
      {/each}
    </nav>
    <div class="sidebar-rail">
      <div class="rail">
        <div class="rail-head"><span class="rail-pulse" class:dim={!anyWorking}></span><span>agent activity</span></div>
        {#if fleet}
          <div class="fleet" class:stale={!fleetFresh} title="live agent fleet (heartbeat)">
            <span class="fleet-dot"></span>
            <span class="fleet-nums mono">{fleet.totals.workflows} workflow{fleet.totals.workflows === 1 ? '' : 's'} · {fleet.totals.subagents} subagent{fleet.totals.subagents === 1 ? '' : 's'}</span>
            <span class="fleet-age mono">{fleetAge == null ? '' : fleetAge === 0 ? 'now' : fleetAge + 'm ago'}</span>
          </div>
        {/if}
        <div class="rail-list">
          {#each agents as a (a.h)}
            {@const working = a.tasks.length > 0}
            <div class="rail-agent {working ? 'working' : 'idle'}" style="--c:{a.color}">
              <span class="ra-top">
                <span class="ra-dot"></span>
                <span class="ra-name mono">{a.name}</span>
                <span class="ra-status s-{working ? 'working' : 'idle'}">{working ? 'working' : 'idle'}</span>
              </span>
              {#if working}
                <a class="ra-item" href="/task/{a.tasks[0].id}">
                  <span class="ra-title">{a.tasks[0].title}</span>
                  <span class="ra-lease">{a.tasks.length > 1 ? `+${a.tasks.length - 1} more in progress` : 'in progress'}</span>
                </a>
              {:else}
                <span class="ra-idle mono">{a.cap}</span>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    </div>
    <div class="sidebar-foot">
      <span class="avatar" style="width:26px;height:26px;font-size:11px;color:#fb7185;border-color:#fb7185;background:#fb718522">p</span>
      <div class="sf-who"><span class="sf-name">Alice</span><span class="mono dim">human · alice + bob</span></div>
      <button class="ico-theme" onclick={toggleTheme} title="Theme" aria-label="Theme"><svg width="16" height="16"><use href="#i-moon"/></svg></button>
    </div>
  </aside>

  <header class="topbar">
    <a class="brand" href="/"><span class="brand-dot"></span><span class="brand-name">tasks</span></a>
    <button class="ico-theme" onclick={toggleTheme} title="Theme" aria-label="Theme"><svg width="18" height="18"><use href="#i-moon"/></svg></button>
  </header>

  <main class="main">{@render children()}</main>

  <nav class="tabbar">
    {#each nav as n}
      <a class="tab" class:on={active(n.name)} href={n.href}>
        <svg width="20" height="20"><use href="#i-{n.icon}"/></svg><span>{n.label}</span>
      </a>
    {/each}
  </nav>
</div>

<style>
  .sidebar-foot .ico-theme, .topbar .ico-theme {
    margin-left: auto; width: 32px; height: 32px; padding: 7px; border-radius: var(--radius);
    color: var(--text-3); display: flex; align-items: center; justify-content: center;
  }
  .sidebar-foot .ico-theme:hover, .topbar .ico-theme:hover { background: var(--surface-2); color: var(--text-1); }
  .snav-item { text-decoration: none; }
  .rail-agent .ra-item { text-decoration: none; cursor: pointer; }
  .rail-agent .ra-item:hover .ra-title { color: var(--c); }
  .rail-pulse.dim { background: var(--text-4); box-shadow: none; animation: none; }
  .fleet { display: flex; align-items: center; gap: 7px; margin: 9px 0 3px; padding: 7px 9px; border-radius: var(--radius); background: var(--surface-2); border: 1px solid var(--border-sub); }
  .fleet-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex: none; box-shadow: 0 0 6px var(--accent); }
  .fleet.stale .fleet-dot { background: var(--text-4); box-shadow: none; }
  .fleet-nums { font-size: 11px; color: var(--text-2); }
  .fleet.stale .fleet-nums { color: var(--text-4); }
  .fleet-age { margin-left: auto; font-size: 10px; color: var(--text-4); }
</style>
