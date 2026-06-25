<script>
  import { page } from '$app/stores';
  import Icon from '$lib/Icon.svelte';

  let { me = 'dev', whoName = 'dev', collapsed = $bindable(false), fleet = null, onToggleTheme } = $props();

  const path = $derived($page.url.pathname);
  const isActive = (n) => {
    const p = path;
    if (n === 'desk') return p === '/';
    if (n === 'browse') return p === '/browse' || p.startsWith('/task') || p.startsWith('/board');
    if (n === 'issues') return p.startsWith('/issues');
    if (n === 'docs') return p.startsWith('/docs');
    if (n === 'gallery') return p.startsWith('/gallery');
    if (n === 'projects') return p.startsWith('/projects');
    if (n === 'fleet') return p.startsWith('/fleet');
    return false;
  };

  // Nav: Inbox folded into the Desk; Issues retired (Bob); Fleet is the status card below.
  const groups = [
    { label: null, items: [
      { id: 'desk', label: 'Desk', href: '/', icon: 'desk' },
      { id: 'browse', label: 'Browse', href: '/browse', icon: 'board' },
    ]},
    { label: 'Library', items: [
      { id: 'docs', label: 'Docs', href: '/docs', icon: 'doc' },
      { id: 'gallery', label: 'Gallery', href: '/gallery', icon: 'gallery' },
      { id: 'projects', label: 'Projects', href: '/projects', icon: 'projects' },
    ]},
  ];

  const agents = $derived(fleet?.agents ?? []);
  const working = $derived(fleet?.totals?.working ?? 0);
</script>

<aside class="nav" class:collapsed>
  <a class="brand" href="/" aria-label="tasks home">
    <span class="brand-mark"><Icon name="brand" size={20} strokeWidth={2} /></span>
    <span class="wordmark">tasks</span>
  </a>

  <a class="new-btn" href="/new">
    <Icon name="plus" size={18} strokeWidth={2.2} />
    <span class="lbl">New task</span>
  </a>

  <nav class="groups" aria-label="Main navigation">
    {#each groups as g}
      {#if g.label}<p class="grp-label">{g.label}</p>{/if}
      {#each g.items as item}
        {@const on = isActive(item.id)}
        <a class="item" class:on href={item.href} aria-current={on ? 'page' : undefined}>
          <Icon name={item.icon} size={18} />
          <span class="lbl">{item.label}</span>
        </a>
      {/each}
    {/each}
  </nav>

  <!-- live fleet status (clickable → /fleet) — restored to the sidebar -->
  <a class="fleet" class:on={isActive('fleet')} href="/fleet" aria-label="Agent fleet — {working} working">
    <div class="fleet-head">
      <Icon name="bolt" size={16} />
      <span class="lbl">Fleet</span>
      <span class="fleet-n">{working}</span>
    </div>
    {#if !collapsed && agents.length}
      <div class="fleet-list">
        {#each agents.slice(0, 4) as a}
          <span class="fa" title="{a.handle} · {a.status}">
            <span class="fa-dot s-{a.status}"></span><span class="fa-h">{a.handle}</span>
          </span>
        {/each}
      </div>
    {/if}
  </a>

  <div class="foot">
    <span class="avatar usr">{whoName.charAt(0)}</span>
    <span class="who">
      <span class="nm">{whoName}</span>
      <span class="sub mono">@{me}</span>
    </span>
    <button class="theme" onclick={onToggleTheme} title="Theme" aria-label="Toggle theme">
      <Icon name="moon" size={16} />
    </button>
  </div>
</aside>

<style>
  .nav {
    --w: 232px;
    width: var(--w); flex-shrink: 0;
    height: 100dvh; box-sizing: border-box;
    display: flex; flex-direction: column; gap: 2px;
    padding: 16px 12px 12px;
    background: var(--surface-1);
    border-right: 1px solid var(--border-sub);
    transition: width .26s cubic-bezier(.4,0,.2,1);
    overflow: hidden; position: relative; z-index: 6;
  }
  .nav.collapsed { --w: 68px; padding-left: 10px; padding-right: 10px; }

  .brand { display: flex; align-items: center; gap: 10px; padding: 2px 8px 12px; text-decoration: none; min-width: 0; }
  .brand-mark { display: grid; place-items: center; width: 28px; height: 28px; flex-shrink: 0;
    color: var(--accent-b); }
  .wordmark { font-weight: 750; font-size: 18px; letter-spacing: -.01em; color: var(--text-1);
    white-space: nowrap; transition: opacity .16s; }
  .collapsed .brand { justify-content: center; padding-left: 0; padding-right: 0; gap: 0; }
  .collapsed .wordmark { opacity: 0; width: 0; }

  /* primary action — SOLID accent fill so it's clearly distinct from the active-tab tint */
  .new-btn { display: flex; align-items: center; gap: 10px; margin: 0 2px 10px; padding: 9px 11px;
    border-radius: var(--radius); text-decoration: none; white-space: nowrap;
    color: #1a1205; background: var(--accent);
    font-size: 13px; font-weight: 650; transition: background .14s; }
  :global(html.skin-paper-ink[data-theme='light']) .new-btn,
  :global(html.skin-paper-ink [data-theme='light']) .new-btn { color: #fff; }
  .new-btn :global(svg) { flex-shrink: 0; }
  .new-btn:hover { background: var(--accent-b); }
  .collapsed .new-btn { justify-content: center; padding-left: 0; padding-right: 0; }
  .collapsed .new-btn .lbl { display: none; }

  .groups { flex: 1; display: flex; flex-direction: column; gap: 2px; overflow-y: auto; overflow-x: hidden;
    margin: 0 -2px; padding: 0 2px; }
  .grp-label { margin: 14px 0 4px; padding: 0 11px; font-size: 10px; font-weight: 700;
    text-transform: uppercase; letter-spacing: .12em; color: var(--text-4); white-space: nowrap; }
  .collapsed .grp-label { opacity: 0; height: 1px; margin: 8px 8px; padding: 0; background: var(--border-sub); overflow: hidden; }

  .item { display: flex; align-items: center; gap: 11px;
    padding: 8px 11px; border-radius: var(--radius); text-decoration: none; white-space: nowrap;
    color: var(--text-3); font-size: 13.5px; font-weight: 500; transition: background .14s, color .14s; }
  .item :global(svg) { flex-shrink: 0; }
  .item:hover { background: var(--surface-2); color: var(--text-1); }
  /* single highlight: the pill fill + the icon picks up accent — no second tile background */
  .item.on { background: var(--accent-bg); color: var(--accent-b); font-weight: 600; }
  .item .lbl { transition: opacity .16s; }
  .collapsed .item { justify-content: center; padding-left: 0; padding-right: 0; gap: 0; }
  .collapsed .item .lbl { display: none; }

  /* fleet status — clickable, live agent dots */
  .fleet { display: block; margin: 8px 2px 2px; padding: 9px 11px; border-radius: var(--radius);
    text-decoration: none; color: var(--text-3); transition: background .14s; }
  .fleet:hover { background: var(--surface-2); color: var(--text-1); }
  .fleet.on { background: var(--accent-bg); color: var(--accent-b); }
  .fleet-head { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; white-space: nowrap; }
  .fleet-head :global(svg) { flex-shrink: 0; }
  .fleet-head .lbl { letter-spacing: .01em; }
  .fleet-head .fleet-n { margin-left: auto; font-family: var(--mono); font-size: 11px;
    background: var(--surface-3); color: var(--text-2); border-radius: 999px; padding: 1px 8px; }
  .collapsed .fleet { text-align: center; padding-left: 0; padding-right: 0; }
  .collapsed .fleet-head { justify-content: center; }
  .collapsed .fleet-head .lbl, .collapsed .fleet-head .fleet-n { display: none; }
  .fleet-list { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
  .fa { display: flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--text-3); min-width: 0; }
  .fa-h { font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fa-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: var(--text-4); }
  .fa-dot.s-working { background: var(--violet); }
  .fa-dot.s-alive { background: var(--info); }
  .fa-dot.s-idle { background: var(--text-4); }
  .fa-dot.s-offline { background: var(--text-4); opacity: .45; }

  .foot { display: flex; align-items: center; gap: 10px; margin-top: 8px;
    padding: 11px 6px 4px; border-top: 1px solid var(--border-sub); }
  .foot .usr { width: 30px; height: 30px; font-size: 13px;
    color: var(--accent-b); border-color: var(--accent); background: var(--accent-bg); }
  .who { display: flex; flex-direction: column; line-height: 1.25; min-width: 0; flex: 1;
    white-space: nowrap; transition: opacity .16s; }
  .who .nm { font-size: 13px; font-weight: 600; color: var(--text-1); }
  .who .sub { font-size: 10.5px; color: var(--text-4); }
  .theme { width: 30px; height: 30px; flex-shrink: 0; display: grid; place-items: center;
    border-radius: var(--radius); color: var(--text-3); }
  .theme:hover { background: var(--surface-2); color: var(--text-1); }
  .collapsed .foot { justify-content: center; padding-left: 0; padding-right: 0; }
  .collapsed .who, .collapsed .theme { display: none; }
</style>
