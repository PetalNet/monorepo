<script>
  import '../app.css';
  import { page } from '$app/stores';
  import Stickies from '$lib/Stickies.svelte';
  import NavSidebar from '$lib/NavSidebar.svelte';
  import Icon from '$lib/Icon.svelte';
  let { children, data } = $props();

  // sidebar collapse — persisted
  let collapsed = $state(false);
  $effect(() => { try { collapsed = localStorage.getItem('tasks-nav-collapsed') === '1'; } catch {} });
  $effect(() => { try { localStorage.setItem('tasks-nav-collapsed', collapsed ? '1' : '0'); } catch {} });

  // who's signed in (Authentik -> locals.user -> data.user)
  const WHO = { alice: 'Alice', alice: 'Alice', bob: 'Bob', bob: 'Bob', bob: 'Bob', dev: 'dev' };
  const me = $derived(String(data.user || 'dev').toLowerCase());
  const whoName = $derived(WHO[me] ?? (me.charAt(0).toUpperCase() + me.slice(1)));

  const path = $derived($page.url.pathname);
  const isActive = (n) => {
    const p = path;
    if (n === 'desk') return p === '/';
    if (n === 'browse') return p === '/browse' || p.startsWith('/task') || p.startsWith('/board');
    if (n === 'fleet') return p.startsWith('/fleet');
    if (n === 'new') return p.startsWith('/new');
    return false;
  };
  // section name for the top bar
  const section = $derived.by(() => {
    const p = path;
    if (p === '/') return 'Desk';
    if (p.startsWith('/browse') || p.startsWith('/board')) return 'Browse';
    if (p.startsWith('/task')) return 'Task';
    if (p.startsWith('/fleet')) return 'Fleet';
    if (p.startsWith('/issues')) return 'Issues';
    if (p.startsWith('/docs')) return 'Docs';
    if (p.startsWith('/gallery')) return 'Gallery';
    if (p.startsWith('/projects') || p.startsWith('/project/')) return 'Projects';
    if (p.startsWith('/new')) return 'New task';
    if (p.startsWith('/inbox')) return 'Inbox';
    return 'tasks';
  });

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('tasks-theme', next); } catch {}
  }
</script>

<div class="app">
  <!-- DESKTOP SIDEBAR — Nexus-style grouped nav, collapses to an icon rail -->
  <NavSidebar {me} {whoName} bind:collapsed fleet={data.fleet} onToggleTheme={toggleTheme} />

  <!-- MOBILE topbar -->
  <header class="topbar">
    <a class="brand" href="/"><span class="brand-mark"><Icon name="brand" size={18} strokeWidth={2} /></span><span class="brand-name">tasks</span></a>
    <button class="ico-theme" onclick={toggleTheme} title="Theme" aria-label="Theme"><Icon name="moon" size={18} /></button>
  </header>

  <main class="main">
    <!-- DESKTOP top bar — sidebar toggle + section (Nexus-style) -->
    <header class="topbar-d">
      <button class="tb-toggle" onclick={() => (collapsed = !collapsed)} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={collapsed ? 'Expand' : 'Collapse'}>
        <Icon name={collapsed ? 'expand' : 'collapse'} size={18} />
      </button>
      <span class="tb-title">{section}</span>
    </header>
    {@render children()}
  </main>

  <!-- MOBILE bottom tab bar + More sheet -->
  <input type="checkbox" id="more-tgl" hidden />
  <label class="sheet-bd" for="more-tgl" aria-hidden="true"></label>
  <div class="sheet" role="dialog" aria-label="More">
    <h3>More</h3>
    <a href="/docs"><Icon name="doc" size={20} />Docs</a>
    <a href="/gallery"><Icon name="gallery" size={20} />Gallery</a>
    <a href="/projects"><Icon name="projects" size={20} />Projects</a>
  </div>
  <nav class="tabbar">
    <a class="tab" class:on={isActive('desk')} href="/"><Icon name="desk" size={20} /><span>Desk</span></a>
    <a class="tab" class:on={isActive('browse')} href="/browse"><Icon name="board" size={20} /><span>Browse</span></a>
    <a class="tab" class:on={isActive('fleet')} href="/fleet"><Icon name="bolt" size={20} /><span>Fleet</span></a>
    <a class="tab" class:on={isActive('new')} href="/new"><Icon name="plus" size={20} /><span>New</span></a>
    <label class="tab" for="more-tgl"><Icon name="more" size={20} /><span>More</span></label>
  </nav>
</div>

<Stickies />

<style>
  /* ── shell layout ─────────────────────────────────────── */
  .app { height: 100dvh; display: flex; overflow: hidden; }
  .main { flex: 1; min-width: 0; overflow-y: auto; overflow-x: hidden; height: 100dvh; }

  /* desktop top bar — holds the sidebar toggle + the current section */
  .topbar-d { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 6px;
    height: 48px; padding: 0 16px; background: color-mix(in srgb, var(--surface-1) 86%, transparent);
    backdrop-filter: blur(8px); border-bottom: 1px solid var(--border-sub); }
  .tb-toggle { width: 32px; height: 32px; display: grid; place-items: center; border-radius: var(--radius);
    color: var(--text-3); transition: background .14s, color .14s; }
  .tb-toggle:hover { background: var(--surface-2); color: var(--text-1); }
  .tb-title { font-size: 13px; font-weight: 600; color: var(--text-2); letter-spacing: -.005em; }

  /* mobile chrome hidden on desktop */
  .topbar, .tabbar, .sheet, .sheet-bd { display: none; }

  /* ── responsive: phone (mirrors the app's 760px container query) ── */
  @container app (max-width: 760px) {
    .app { display: flex; flex-direction: column; }
    .app :global(.nav) { display: none; }
    .topbar-d { display: none; }
    .topbar { display: flex; align-items: center; justify-content: space-between; padding: 9px 15px;
      background: var(--surface-1); border-bottom: 1px solid var(--border-sub); position: sticky; top: 0; z-index: 5; }
    .topbar .brand { display: flex; align-items: center; gap: 9px; text-decoration: none; }
    .topbar .brand-mark { display: grid; place-items: center; color: var(--accent-b); }
    .topbar .brand-name { font-weight: 750; font-size: 16px; letter-spacing: -.01em; color: var(--text-1); }
    .topbar .ico-theme { width: 32px; height: 32px; display: grid; place-items: center; border-radius: var(--radius); color: var(--text-3); }
    .topbar .ico-theme:hover { background: var(--surface-2); color: var(--text-1); }
    .main { height: auto; flex: 1; }

    .tabbar { display: flex; background: var(--surface-1); border-top: 1px solid var(--border-sub); flex-shrink: 0;
      padding: 6px 6px calc(6px + env(safe-area-inset-bottom)); position: sticky; bottom: 0; z-index: 5; }
    .tab { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 7px 4px;
      border-radius: var(--radius); color: var(--text-4); font-size: 9.5px; font-weight: 600; text-decoration: none; cursor: pointer; }
    .tab.on { color: var(--accent-b); }

    /* "More" sheet — the tucked-away secondary nav */
    #more-tgl:checked ~ .sheet-bd { display: block; position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 40; }
    #more-tgl:checked ~ .sheet { display: flex; }
    .sheet { position: fixed; left: 0; right: 0; bottom: 0; z-index: 41; flex-direction: column; gap: 2px;
      background: var(--surface-1); border-top: 1px solid var(--border); border-radius: var(--radius-lg) var(--radius-lg) 0 0;
      padding: 10px 12px calc(16px + env(safe-area-inset-bottom)); }
    .sheet h3 { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: var(--text-4);
      font-family: var(--mono); padding: 8px 8px 6px; }
    .sheet a { display: flex; align-items: center; gap: 12px; padding: 13px 12px; border-radius: var(--radius);
      color: var(--text-2); font-size: 14.5px; font-weight: 500; text-decoration: none; }
    .sheet a:hover { background: var(--surface-2); }
  }

  :where(a, button, input, select, label, [tabindex]):focus-visible { outline: 2px solid var(--accent-b); outline-offset: 2px; border-radius: 3px; }
</style>
