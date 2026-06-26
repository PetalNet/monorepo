<script>
  import { page } from '$app/stores';
  import Icon from '$lib/Icon.svelte';

  // Account moved UP to the top bar (task-499); the sidebar foot is now the live Fleet card.
  let { collapsed = $bindable(false), fleet = null } = $props();

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
  const online = $derived(fleet?.totals?.online ?? 0);
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

  <!-- FOOT: the live Fleet — full known roster, greyed when offline. Clickable → /fleet. -->
  <a class="fleet" class:on={isActive('fleet')} href="/fleet"
     aria-label="Agent fleet — {working} working, {online} online of {agents.length}">
    <div class="fleet-head">
      <Icon name="bolt" size={16} />
      <span class="lbl">Fleet</span>
      <span class="fleet-n" class:live={working > 0}>{working ? `${working} working` : `${online}/${agents.length}`}</span>
    </div>
    {#if !collapsed && agents.length}
      <div class="fleet-list">
        {#each agents as a}
          <span class="fa" class:off={a.offline} title="{a.handle}{a.host ? ` · ${a.host}` : ''} · {a.offline ? (a.never_seen ? 'never reported' : 'offline') : a.status}{a.current_tool ? ` · ${a.current_tool}` : ''}">
            <span class="fa-dot s-{a.status}"></span>
            <span class="fa-h">{a.handle}</span>
            {#if a.status === 'working'}<span class="fa-x mono">working</span>
            {:else if a.offline}<span class="fa-x off">offline</span>{/if}
          </span>
        {/each}
      </div>
    {/if}
  </a>
</aside>

<style>
  .nav {
    --w: 232px;
    width: var(--w); flex-shrink: 0;
    height: 100dvh; box-sizing: border-box;
    display: flex; flex-direction: column; gap: 2px;
    padding: 12px 12px 12px;
    background: var(--surface-1);
    border-right: 1px solid var(--border-sub); border-radius: 0;
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
  /* collapsed: 34×34 centered square — 18px icon + 8px padding all round, matching the
     expanded rows' vertical padding so icons don't change size/box on collapse (Bob) */
  .collapsed .new-btn { justify-content: center; gap: 0; width: 34px; height: 34px; padding: 0; margin: 0 auto 10px; }
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
  .collapsed .item { justify-content: center; gap: 0; width: 34px; height: 34px; padding: 0; margin: 0 auto; }
  .collapsed .item .lbl { display: none; }

  /* FOOT: live Fleet — full roster, the sidebar's bottom anchor (clickable → /fleet) */
  .fleet { display: block; margin-top: 8px; padding: 11px 9px 4px; border-top: 1px solid var(--border-sub);
    text-decoration: none; color: var(--text-3); transition: color .14s; }
  .fleet:hover { color: var(--text-1); }
  .fleet:hover .fleet-head .lbl { color: var(--text-1); }
  .fleet.on .fleet-head .lbl { color: var(--accent-b); }
  .fleet-head { display: flex; align-items: center; gap: 8px; font-size: 11px; font-weight: 700;
    text-transform: uppercase; letter-spacing: .1em; color: var(--text-4); white-space: nowrap; }
  .fleet-head :global(svg) { flex-shrink: 0; }
  .fleet-head .fleet-n { margin-left: auto; font-family: var(--mono); font-size: 10.5px;
    letter-spacing: 0; text-transform: none; font-weight: 500; color: var(--text-4); }
  .fleet-head .fleet-n.live { color: var(--violet); }
  .collapsed .fleet { text-align: center; padding-left: 0; padding-right: 0; }
  .collapsed .fleet-head { justify-content: center; }
  .collapsed .fleet-head .lbl, .collapsed .fleet-head .fleet-n { display: none; }
  .fleet-list { display: flex; flex-direction: column; gap: 0; margin-top: 7px; }
  .fa { display: flex; align-items: center; gap: 8px; padding: 4px 3px; font-size: 12.5px; color: var(--text-2);
    min-width: 0; }
  .fa.off { color: var(--text-4); }
  .fa-h { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fa-x { margin-left: auto; font-size: 9px; text-transform: uppercase; letter-spacing: .07em; font-weight: 600; }
  .fa-x.off { color: var(--text-4); }
  .fa .fa-x:not(.off) { color: var(--violet); }
  .fa-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: var(--text-4); }
  .fa-dot.s-working { background: var(--violet); }
  .fa-dot.s-alive { background: var(--info); }
  .fa-dot.s-idle { background: var(--text-3); }
  .fa-dot.s-offline { background: var(--text-4); opacity: .4; }
</style>
