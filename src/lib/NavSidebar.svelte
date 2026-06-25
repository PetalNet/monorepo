<script>
  import { page } from '$app/stores';

  let { me = 'dev', whoName = 'dev', whoSub = '', collapsed = $bindable(false), onToggleTheme } = $props();

  const path = $derived($page.url.pathname);
  const isActive = (n) => {
    const p = path;
    if (n === 'desk') return p === '/';
    if (n === 'browse') return p === '/browse' || p.startsWith('/task') || p.startsWith('/board');
    if (n === 'fleet') return p.startsWith('/fleet');
    if (n === 'new') return p.startsWith('/new');
    if (n === 'inbox') return p.startsWith('/inbox');
    if (n === 'issues') return p.startsWith('/issues');
    if (n === 'docs') return p.startsWith('/docs');
    if (n === 'gallery') return p.startsWith('/gallery');
    if (n === 'projects') return p.startsWith('/projects');
    return false;
  };

  // Grouped nav — stolen from Nexus's NavSidebar (labeled sections, active = petal
  // pill + left accent bar + icon tile). Translated from Tailwind to paper-ink tokens.
  const groups = [
    { label: null, items: [
      { id: 'desk', label: 'Desk', href: '/', icon: 'i-cockpit' },
    ]},
    { label: 'Work', items: [
      { id: 'browse', label: 'Browse', href: '/browse', icon: 'i-board' },
      { id: 'fleet', label: 'Fleet', href: '/fleet', icon: 'i-bolt' },
      { id: 'inbox', label: 'Inbox', href: '/inbox', icon: 'i-inbox' },
      { id: 'issues', label: 'Issues', href: '/issues', icon: 'i-iopen' },
    ]},
    { label: 'Library', items: [
      { id: 'docs', label: 'Docs', href: '/docs', icon: 'i-doc' },
      { id: 'gallery', label: 'Gallery', href: '/gallery', icon: 'i-gallery' },
      { id: 'projects', label: 'Projects', href: '/projects', icon: 'i-projects' },
    ]},
  ];
</script>

<aside class="nav" class:collapsed>
  <a class="brand" href="/" aria-label="tasks home">
    <span class="dot"></span><span class="wordmark">tasks</span>
  </a>

  <a class="new-btn" class:on={isActive('new')} href="/new">
    <svg width="18" height="18" aria-hidden="true"><use href="#i-plus"/></svg>
    <span class="lbl">New task</span>
  </a>

  <nav class="groups" aria-label="Main navigation">
    {#each groups as g}
      {#if g.label}
        <p class="grp-label">{g.label}</p>
      {:else if g.items[0].id !== 'desk'}
        <div class="grp-div" aria-hidden="true"></div>
      {/if}
      {#each g.items as item}
        {@const on = isActive(item.id)}
        <a class="item" class:on href={item.href} aria-current={on ? 'page' : undefined}>
          <span class="tile"><svg width="17" height="17" aria-hidden="true"><use href="#{item.icon}"/></svg></span>
          <span class="lbl">{item.label}</span>
        </a>
      {/each}
    {/each}
  </nav>

  <div class="foot">
    <span class="avatar usr" style="width:30px;height:30px;font-size:13px;">{whoName.charAt(0)}</span>
    <span class="who">
      <span class="nm">{whoName}</span>
      <span class="sub mono">{whoSub}</span>
    </span>
    <button class="theme" onclick={onToggleTheme} title="Theme" aria-label="Toggle theme">
      <svg width="16" height="16" aria-hidden="true"><use href="#i-moon"/></svg>
    </button>
  </div>

  <button class="collapse" onclick={() => (collapsed = !collapsed)} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {#if collapsed}<path d="m9 6 6 6-6 6"/>{:else}<path d="m15 6-6 6 6 6"/>{/if}
    </svg>
    <span class="lbl">Collapse</span>
  </button>
</aside>

<style>
  /* Stolen from Nexus's NavSidebar — grouped, labeled, full-width sidebar that
     collapses to an icon rail. Active item = petal-tinted pill + left accent bar +
     filled icon tile. All Tailwind utilities translated to paper-ink CSS vars. */
  .nav {
    --w: 232px;
    width: var(--w); flex-shrink: 0;
    height: 100dvh; box-sizing: border-box;
    display: flex; flex-direction: column; gap: 2px;
    padding: 18px 12px 12px;
    background: var(--surface-1);
    border-right: 1px solid var(--border-sub);
    transition: width .28s cubic-bezier(.4,0,.2,1);
    overflow: hidden; position: relative; z-index: 6;
  }
  .nav.collapsed { --w: 70px; padding-left: 11px; padding-right: 11px; }

  .brand { display: flex; align-items: center; gap: 11px; padding: 2px 8px 14px; text-decoration: none; min-width: 0; }
  .brand .dot { width: 11px; height: 11px; border-radius: 4px; flex-shrink: 0;
    background: var(--accent); }
  .brand .wordmark { font-weight: 800; font-size: 19px; letter-spacing: -.03em; color: var(--text-1);
    white-space: nowrap; transition: opacity .18s; }
  .collapsed .brand { justify-content: center; padding-left: 0; padding-right: 0; }
  .collapsed .brand .wordmark { opacity: 0; width: 0; }

  /* prominent New action — petal-outlined call to action */
  .new-btn { display: flex; align-items: center; gap: 11px; margin: 0 2px 8px; padding: 9px 11px;
    border-radius: var(--radius); text-decoration: none; white-space: nowrap;
    color: var(--accent-b); background: var(--accent-bg);
    font-size: 13px; font-weight: 600; transition: .14s; }
  .new-btn svg { flex-shrink: 0; }
  .new-btn:hover { background: color-mix(in srgb, var(--accent) 18%, var(--surface-1)); }
  .collapsed .new-btn { justify-content: center; padding-left: 0; padding-right: 0; }
  .collapsed .new-btn .lbl { display: none; }

  .groups { flex: 1; display: flex; flex-direction: column; gap: 2px; overflow-y: auto; overflow-x: hidden;
    margin: 0 -2px; padding: 0 2px; }
  .grp-label { margin: 14px 0 4px; padding: 0 11px; font-size: 10px; font-weight: 700;
    text-transform: uppercase; letter-spacing: .15em; color: var(--text-4); white-space: nowrap; }
  .collapsed .grp-label { opacity: 0; height: 1px; margin: 8px 8px; padding: 0; background: var(--border-sub); overflow: hidden; }
  .grp-div { height: 1px; background: var(--border-sub); margin: 8px 6px; }

  .item { position: relative; display: flex; align-items: center; gap: 11px;
    padding: 8px 11px; border-radius: var(--radius); text-decoration: none; white-space: nowrap;
    color: var(--text-3); font-size: 13.5px; font-weight: 500; transition: .14s; }
  .item:hover { background: var(--surface-2); color: var(--text-1); }
  .item.on { background: var(--accent-bg); color: var(--text-1); font-weight: 600; }
  .item .tile { width: 30px; height: 30px; flex-shrink: 0; border-radius: var(--radius-sm);
    display: flex; align-items: center; justify-content: center; color: inherit; transition: .14s; }
  .item.on .tile { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent-b); }
  .item:not(.on):hover .tile { background: var(--surface-3); }
  .item .lbl { transition: opacity .18s; }
  .collapsed .item { justify-content: center; padding-left: 0; padding-right: 0; gap: 0; }
  .collapsed .item .lbl { display: none; }

  .foot { display: flex; align-items: center; gap: 10px; margin-top: 6px;
    padding: 11px 6px 4px; border-top: 1px solid var(--border-sub); }
  .foot .usr { color: var(--accent-b); border-color: var(--accent); background: var(--accent-bg); }
  .who { display: flex; flex-direction: column; line-height: 1.25; min-width: 0; flex: 1;
    white-space: nowrap; transition: opacity .18s; }
  .who .nm { font-size: 13px; font-weight: 600; color: var(--text-1); }
  .who .sub { font-size: 10px; color: var(--text-4); }
  .theme { width: 30px; height: 30px; flex-shrink: 0; padding: 7px; border-radius: var(--radius);
    color: var(--text-3); display: flex; align-items: center; justify-content: center; }
  .theme:hover { background: var(--surface-2); color: var(--text-1); }
  .collapsed .foot { justify-content: center; padding-left: 0; padding-right: 0; }
  .collapsed .who, .collapsed .theme { display: none; }

  .collapse { display: flex; align-items: center; gap: 11px; margin-top: 2px; padding: 8px 11px;
    border-radius: var(--radius); color: var(--text-4); transition: .14s; white-space: nowrap; }
  .collapse:hover { background: var(--surface-2); color: var(--text-2); }
  .collapse svg { flex-shrink: 0; }
  .collapse .lbl { font-size: 12px; }
  .collapsed .collapse { justify-content: center; padding-left: 0; padding-right: 0; }
  .collapsed .collapse .lbl { display: none; }
</style>
