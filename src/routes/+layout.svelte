<script>
  import '../app.css';
  import { page } from '$app/stores';
  import Stickies from '$lib/Stickies.svelte';
  import NavSidebar from '$lib/NavSidebar.svelte';
  let { children, data } = $props();

  // sidebar collapse — persisted, restored before paint via the inline script in app.html fallback
  let collapsed = $state(false);
  $effect(() => {
    try { collapsed = localStorage.getItem('tasks-nav-collapsed') === '1'; } catch {}
  });
  $effect(() => {
    try { localStorage.setItem('tasks-nav-collapsed', collapsed ? '1' : '0'); } catch {}
  });

  // who's actually signed in (Authentik -> locals.user -> data.user)
  const WHO = { alice: { name: 'Alice', sub: 'owner' }, alice: { name: 'Alice', sub: 'owner' }, bob: { name: 'Bob', sub: 'collab' }, bob: { name: 'Bob', sub: 'collab' }, bob: { name: 'Bob', sub: 'collab' }, dev: { name: 'dev', sub: 'local dev' } };
  const me = $derived(String(data.user || 'dev').toLowerCase());
  const whoName = $derived(WHO[me]?.name ?? (me.charAt(0).toUpperCase() + me.slice(1)));
  const whoSub = $derived(WHO[me]?.sub ?? `signed in · ${me}`);

  // active-state matcher for the mobile tab bar
  const path = $derived($page.url.pathname);
  const isActive = (n) => {
    const p = path;
    if (n === 'cockpit') return p === '/';
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

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('tasks-theme', next); } catch {}
  }
</script>

<!-- shared icon set (used by the shell + every page) -->
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <symbol id="i-cockpit" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11 12 4l9 7"/><path d="M5 10v9h14v-9"/><path d="M9 19v-5h6v5"/></symbol>
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
  <symbol id="i-plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></symbol>
  <symbol id="i-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></symbol>
  <symbol id="i-sticky" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h14v10l-5 5H5z"/><path d="M19 14h-5v5"/></symbol>
  <symbol id="i-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M20 14a8 8 0 1 1-10-10 6.5 6.5 0 0 0 10 10z"/></symbol>
  <symbol id="i-iopen" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none"/></symbol>
  <symbol id="i-iclosed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.4 2.4 4.6-4.8"/></symbol>
  <symbol id="i-comment" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5h14v11H9l-4 3z"/></symbol>
  <symbol id="i-gallery" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m3 16 5-5 4 4 3-3 6 6"/><circle cx="8.5" cy="9" r="1.4"/></symbol>
  <symbol id="i-more" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/></symbol>
  <symbol id="i-car" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></symbol>
  <symbol id="i-fire" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3c1 3-1 4-1 6a3 3 0 0 0 6 0c0-1-.3-2-1-3 2 1.5 3 4 3 6a6 6 0 0 1-12 0c0-3 2-5 3-6 .5 1.5 1 2 2 2 .5-2 0-3 0-5z"/></symbol>
  <symbol id="i-pulse" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2-6 4 12 2-6h6"/></symbol>
  <symbol id="i-clock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></symbol>
  <symbol id="i-shield" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6z"/><path d="m9 12 2 2 4-4"/></symbol>
</defs></svg>

<div class="app">
  <!-- DESKTOP SIDEBAR — Nexus-style grouped nav, collapses to an icon rail -->
  <NavSidebar {me} {whoName} {whoSub} bind:collapsed onToggleTheme={toggleTheme} />

  <!-- MOBILE topbar -->
  <header class="topbar">
    <a class="brand" href="/"><span class="brand-dot"></span><span class="brand-name">tasks</span></a>
    <button class="ico-theme" onclick={toggleTheme} title="Theme" aria-label="Theme"><svg width="18" height="18" aria-hidden="true"><use href="#i-moon"/></svg></button>
  </header>

  <main class="main">{@render children()}</main>

  <!-- MOBILE bottom tab bar + More sheet -->
  <input type="checkbox" id="more-tgl" hidden />
  <label class="sheet-bd" for="more-tgl" aria-hidden="true"></label>
  <div class="sheet" role="dialog" aria-label="More">
    <h3>More</h3>
    <a href="/inbox"><svg width="20" height="20" aria-hidden="true"><use href="#i-inbox"/></svg>Inbox</a>
    <a href="/issues"><svg width="20" height="20" aria-hidden="true"><use href="#i-iopen"/></svg>Issues</a>
    <a href="/docs"><svg width="20" height="20" aria-hidden="true"><use href="#i-doc"/></svg>Docs</a>
    <a href="/gallery"><svg width="20" height="20" aria-hidden="true"><use href="#i-gallery"/></svg>Gallery</a>
    <a href="/projects"><svg width="20" height="20" aria-hidden="true"><use href="#i-projects"/></svg>Projects</a>
  </div>
  <nav class="tabbar">
    <a class="tab" class:on={isActive('cockpit')} href="/"><svg width="20" height="20" aria-hidden="true"><use href="#i-cockpit"/></svg><span>Desk</span></a>
    <a class="tab" class:on={isActive('browse')} href="/browse"><svg width="20" height="20" aria-hidden="true"><use href="#i-board"/></svg><span>Browse</span></a>
    <a class="tab" class:on={isActive('fleet')} href="/fleet"><svg width="20" height="20" aria-hidden="true"><use href="#i-bolt"/></svg><span>Fleet</span></a>
    <a class="tab" class:on={isActive('new')} href="/new"><svg width="20" height="20" aria-hidden="true"><use href="#i-plus"/></svg><span>New</span></a>
    <label class="tab" for="more-tgl"><svg width="20" height="20" aria-hidden="true"><use href="#i-more"/></svg><span>More</span></label>
  </nav>
</div>

<Stickies />

<style>
  /* ── shell layout ─────────────────────────────────────── */
  .app { height: 100dvh; display: flex; overflow: hidden; }
  .main { flex: 1; min-width: 0; overflow-y: auto; overflow-x: hidden; height: 100dvh; }

  /* mobile chrome hidden on desktop */
  .topbar, .tabbar, .sheet, .sheet-bd { display: none; }

  /* ── responsive: phone (mirrors the app's 760px container query) ── */
  @container app (max-width: 760px) {
    .app { display: flex; flex-direction: column; }
    .app :global(.nav) { display: none; }
    .topbar { display: flex; align-items: center; justify-content: space-between; padding: 11px 15px;
      background: var(--surface-1); border-bottom: 1px solid var(--border-sub); position: sticky; top: 0; z-index: 5; }
    .topbar .brand { display: flex; align-items: center; gap: 9px; text-decoration: none; }
    .topbar .brand-dot { width: 9px; height: 9px; border-radius: 3px; background: var(--accent); box-shadow: 0 0 14px var(--accent-ln); }
    .topbar .brand-name { font-weight: 700; font-size: 16px; letter-spacing: -.02em; }
    .topbar .ico-theme { width: 32px; height: 32px; padding: 7px; border-radius: var(--radius); color: var(--text-3);
      display: flex; align-items: center; justify-content: center; }
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
