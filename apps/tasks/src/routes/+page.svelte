<script>
  import { enhance } from '$app/forms';
  import { goto, invalidateAll } from '$app/navigation';
  import Icon from '$lib/Icon.svelte';
  import { radioNav } from '$lib/a11y.js';
  import TaskRow from '$lib/TaskRow.svelte';
  import { humanizeTool } from '$lib/tool.js';
  import { displayName, projectName } from '$lib/people.js';

  let { data } = $props();

  const projName = projectName(data.projects);

  // who's signed in → greeting ('there' is the dev-fallback greeting label)
  const me = $derived(String(data.me || 'dev').toLowerCase());
  const whoName = $derived(displayName(me, 'there'));

  // time-of-day greeting — only needs hour granularity, so tick once a minute
  let now = $state(new Date());
  $effect(() => {
    const id = setInterval(() => { now = new Date(); }, 60_000);
    return () => clearInterval(id);
  });
  // Live desk data: re-fetch the load every minute, ON the minute. invalidateAll() re-runs the
  // server loads and updates `data` reactively — NOT a page reload, so typing/scroll aren't
  // disrupted and an offline blip just fails quietly (Bob). Aligned to the wall-clock minute.
  $effect(() => {
    let interval;
    const refresh = () => invalidateAll().catch(() => {});
    const timeout = setTimeout(() => {
      refresh();
      interval = setInterval(refresh, 60_000);
    }, 60_000 - (Date.now() % 60_000));
    return () => { clearTimeout(timeout); if (interval) clearInterval(interval); };
  });
  const greetWord = $derived(now.getHours() < 12 ? 'Good morning' : now.getHours() < 18 ? 'Good afternoon' : 'Good evening');

  const hud = $derived(data.hud ?? { needsYou: 0, onFire: 0, working: 0 });
  const g = $derived(data.graphs ?? { momentum: { closedToday: 0, series: [] }, backlog: { total: 0, byPriority: {} }, focus: { needsYou: 0, onFire: 0, inFlight: 0, total: 0 } });

  // ── live fleet: handle → telemetry, to enrich the IN FLIGHT lane ──
  const fleetByHandle = $derived(Object.fromEntries((data.fleet?.agents ?? []).map((a) => [a.handle, a])));
  const fmtAge = (ms) => {
    if (ms == null) return '';
    const s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.round(s / 60);
    if (m < 60) return m + 'm';
    const h = Math.round(m / 60);
    return h < 24 ? h + 'h' : Math.round(h / 24) + 'd';
  };

  function relShort(ts) {
    if (!ts) return '';
    const s = Math.round((Date.now() - new Date(/[TZ]/.test(ts) ? ts : ts.replace(' ', 'T') + 'Z').getTime()) / 1000);
    if (s < 60) return s + 's';
    if (s < 3600) return Math.round(s / 60) + 'm';
    if (s < 86400) return Math.round(s / 3600) + 'h';
    return Math.round(s / 86400) + 'd';
  }

  // ── filters (mirror the board; navigate to /browse with the same query) ──
  // task-331: these leave the page — /browse announces the filtered result count in
  // its own live region, and SvelteKit's route announcer reads the new title.
  const pickProject = (e) => { const v = e.target.value; goto('/browse' + (v ? `?project=${encodeURIComponent(v)}` : '')); };
  const pickAssignee = (e) => { const v = e.target.value; goto('/browse' + (v ? `?assignee=${encodeURIComponent(v)}` : '')); };

  // task-359: confirm one-tap answers out loud — the answered row simply vanishes
  // from the lane, which a screen-reader user would otherwise never hear about.
  let liveMsg = $state('');
  const answered = (label) => () => { liveMsg = `Answer submitted: ${label}`; return async ({ update }) => update(); };

  // ── momentum sparkline geometry from the real 14-day series ──
  // Thin filled-area sparkline. preserveAspectRatio="none" stretches X, so the line uses
  // a non-scaling stroke (uniform 1.6px) and there's no end-dot — that's what made the old
  // marker render as a stretched ellipse (Bob: "momentum is still ugly").
  const SPK_BASE = 25, SPK_TOP = 4, SPK_VH = 28;
  const spark = $derived.by(() => {
    const s = g.momentum.series ?? [];
    if (!s.length) return { line: '', area: '', pts: [] };
    const max = Math.max(1, ...s.map((d) => d.n));
    const n = s.length;
    const pts = s.map((d, i) => {
      const x = n === 1 ? 50 : (i / (n - 1)) * 100;
      const y = SPK_BASE - (d.n / max) * (SPK_BASE - SPK_TOP);
      // yPct maps the viewBox y (0–28) to a % of the rendered box, so an HTML overlay
      // (dot/tooltip) lines up with the SVG point under preserveAspectRatio="none".
      return { x, y, yPct: (y / SPK_VH) * 100, n: d.n, day: d.day };
    });
    const line = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const x0 = pts[0].x.toFixed(1), xN = pts[pts.length - 1].x.toFixed(1);
    return { line, area: `${line} ${xN},${SPK_BASE + 3} ${x0},${SPK_BASE + 3}`, pts };
  });

  // interactive momentum: tap/hover a day to read its count (Alice, on mobile)
  let momActive = $state(-1);
  const fmtDay = (day) => {
    if (!day) return '';
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const yest = new Date(Date.now() - 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    if (day === today) return 'today';
    if (day === yest) return 'yesterday';
    return new Date(day + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  };
  const momCap = $derived(
    g.momentum.closedToday > 0
      ? `${g.momentum.closedToday} closed in the last day`
      : 'no closes yet today'
  );

  // ── backlog stacked bar from real counts ──
  const bl = $derived.by(() => {
    const bp = g.backlog.byPriority ?? {};
    const total = g.backlog.total || 0;
    const pct = (n) => (total ? (n / total) * 100 : 0);
    return {
      total,
      p0: bp[0] ?? 0, p1: bp[1] ?? 0, p2: bp[2] ?? 0, p3: bp[3] ?? 0,
      w0: pct(bp[0] ?? 0), w1: pct(bp[1] ?? 0), w2: pct(bp[2] ?? 0), w3: pct(bp[3] ?? 0)
    };
  });

  // ── focus donut: three arcs (need-you / on-fire / in-flight) over the ring ──
  const R = 37, C = 2 * Math.PI * R;            // ≈ 232.48
  const ring = $derived.by(() => {
    const f = g.focus ?? {};
    const total = f.total || 0;
    const segs = [
      { key: 'y', n: f.needsYou ?? 0, stroke: 'var(--violet-b)' },
      { key: 'f', n: f.onFire ?? 0, stroke: 'var(--danger-b)' },
      { key: 'w', n: f.inFlight ?? 0, stroke: 'var(--accent-b)' }
    ].filter((s) => s.n > 0);
    if (!total) return { arcs: [], total: 0 };
    const gap = segs.length > 1 ? 1.5 : 0;
    let offset = 0;
    const arcs = segs.map((s) => {
      const len = Math.max(0, (s.n / total) * C - gap);
      const arc = { ...s, dash: `${len.toFixed(2)} ${(C - len).toFixed(2)}`, dashoffset: (-offset).toFixed(2) };
      offset += (s.n / total) * C;
      return arc;
    });
    return { arcs, total };
  });
</script>

<svelte:head><title>tasks · desk</title></svelte:head>

<div class="screen cockpit">

  <!-- HUD header -->
  <header class="ckhead">
    <h1 class="greet">{greetWord}, <em>{whoName}</em></h1>
    <!-- task-359: polite confirmation when a one-tap answer lands -->
    <span class="vh" role="status" aria-live="polite">{liveMsg}</span>
    <div class="statline">
      <div class="stat you"><span class="n mono">{hud.needsYou}</span><span class="l">need you</span></div>
      <div class="stat fire"><span class="n mono">{hud.onFire}</span><span class="l">on fire</span></div>
      <div class="stat work"><span class="n mono">{hud.working}</span><span class="l">{hud.working === 1 ? 'agent working' : 'agents working'}</span></div>
    </div>
    <div class="filters">
      <span class="fsel">
        <Icon name="projects" size={13} />
        <select onchange={pickProject} aria-label="Project">
          <option value="">all projects</option>
          {#each data.projects as p}<option value={p.name}>{p.name}</option>{/each}
        </select>
      </span>
      {#if data.assignees.length}
        <span class="fsel">
          <select onchange={pickAssignee} aria-label="People">
            <option value="">all people</option>
            {#each data.assignees as a}<option value={a}>{a}</option>{/each}
          </select>
        </span>
      {/if}
    </div>
  </header>

  <!-- GRAPHS STRIP -->
  <section class="graphs" aria-label="At-a-glance charts">

    <!-- momentum -->
    <div class="gcard g-mom">
      <div class="gc-head"><span class="gc-ic"><Icon name="pulse" size={13} /></span>Momentum</div>
      <div class="mom-top">
        <span class="mom-n mono">{momActive >= 0 ? spark.pts[momActive].n : g.momentum.closedToday}</span>
        <span class="mom-unit">{momActive >= 0 ? `closed ${fmtDay(spark.pts[momActive].day)}` : 'closed today'}</span>
      </div>
      <div class="mom-chart" role="group" aria-label="Closes per day, last 14 days — tap a day for its count">
        <svg class="spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
          {#if spark.area}<polygon class="spark-fill" points={spark.area} />{/if}
          <line class="spark-base" x1="0" y1="25" x2="100" y2="25" />
          {#if spark.line}
            <polyline class="spark-line" points={spark.line} vector-effect="non-scaling-stroke" fill="none" />
          {/if}
        </svg>
        {#if momActive >= 0 && spark.pts[momActive]}
          <span class="spark-rule" style="left:{spark.pts[momActive].x}%"></span>
          <span class="spark-dot" style="left:{spark.pts[momActive].x}%; top:{spark.pts[momActive].yPct}%"></span>
        {/if}
        <!-- one hit-column per day; mouse hovers, touch taps-and-keeps (pointerleave only
             clears for mouse, else a tap would revert instantly on finger-up) -->
        <div class="mom-hits" onpointerleave={(e) => { if (e.pointerType === 'mouse') momActive = -1; }}>
          {#each spark.pts as p, i}
            <button class="mom-hit" type="button" class:on={i === momActive}
              aria-label="{fmtDay(p.day)}: {p.n} closed"
              onpointerenter={(e) => { if (e.pointerType === 'mouse') momActive = i; }}
              onfocus={() => (momActive = i)}
              onblur={() => (momActive = -1)}
              onclick={() => (momActive = i)}></button>
          {/each}
        </div>
      </div>
      <div class="mom-cap">{momCap}</div>
    </div>

    <!-- backlog by priority -->
    <div class="gcard g-bl">
      <div class="gc-head"><span class="gc-ic"><Icon name="board" size={13} /></span>Backlog · {bl.total} open</div>
      <div class="bl-bar" role="img" aria-label="Backlog by priority: P0 {bl.p0}, P1 {bl.p1}, P2 {bl.p2}, P3 {bl.p3}">
        <span class="bl-seg bl-p0" style="width:{bl.w0}%"></span>
        <span class="bl-seg bl-p1" style="width:{bl.w1}%"></span>
        <span class="bl-seg bl-p2" style="width:{bl.w2}%"></span>
        <span class="bl-seg bl-p3" style="width:{bl.w3}%"></span>
      </div>
      <div class="bl-legend">
        <span class="bl-key k0"><span class="sw"></span>P0<span class="kc mono">{bl.p0}</span></span>
        <span class="bl-key k1"><span class="sw"></span>P1<span class="kc mono">{bl.p1}</span></span>
        <span class="bl-key k2"><span class="sw"></span>P2<span class="kc mono">{bl.p2}</span></span>
        <span class="bl-key k3"><span class="sw"></span>P3<span class="kc mono">{bl.p3}</span></span>
      </div>
    </div>

    <!-- focus ring -->
    <div class="gcard g-ring">
      <div class="gc-head"><span class="gc-ic"><Icon name="question" size={13} /></span>Your focus</div>
      <div class="ring-wrap">
        <svg class="ring" viewBox="0 0 84 84" role="img" aria-label="Focus: {g.focus.needsYou} need you, {g.focus.onFire} on fire, {g.focus.inFlight} in flight">
          <circle class="ring-bg" cx="42" cy="42" r={R} />
          <g transform="rotate(-90 42 42)">
            {#each ring.arcs as a (a.key)}
              <circle class="ring-seg" cx="42" cy="42" r={R} stroke={a.stroke} stroke-dasharray={a.dash} stroke-dashoffset={a.dashoffset} />
            {/each}
          </g>
          <text class="ring-ctr-n mono" x="42" y="42" text-anchor="middle" dominant-baseline="central">{g.focus.total}</text>
        </svg>
        <div class="ring-legend">
          <span class="ring-key ky"><span class="sw"></span><b class="mono">{g.focus.needsYou}</b> need you</span>
          <span class="ring-key kf"><span class="sw"></span><b class="mono">{g.focus.onFire}</b> on fire</span>
          <span class="ring-key kw"><span class="sw"></span><b class="mono">{g.focus.inFlight}</b> in flight</span>
        </div>
      </div>
    </div>

  </section>

  <!-- quick capture -->
  <form class="capture" method="POST" action="?/capture" use:enhance={() => ({ update }) => update({ reset: true })}>
    <Icon name="plus" size={18} />
    <input name="title" placeholder="Capture an idea or task…" autocomplete="off" aria-label="Capture an idea or task" />
    <kbd class="mono">↵</kbd>
  </form>

  <div class="lanes">

    <!-- ON FIRE -->
    {#if data.onFire.length}
      <section class="lane lane-fire">
        <div class="lane-head">
          <span class="lane-ic"><Icon name="fire" size={15} /></span>
          <h2>On fire</h2><span class="lane-count">{data.onFire.length}</span>
        </div>
        <div class="list">
          {#each data.onFire as t (t.id)}
            <TaskRow task={t} project={projName(t.project_id)} />
          {/each}
        </div>
      </section>
    {/if}

    <!-- NEEDS YOU -->
    {#if data.needsYou.length}
      <section class="lane lane-you">
        <div class="lane-head">
          <span class="lane-ic"><Icon name="question" size={15} /></span>
          <h2>Needs you</h2><span class="lane-count">{data.needsYou.length}</span>
        </div>
        <div class="list">
          {#each data.needsYou as t (t.id)}
            {#if t.reason === 'question'}
              {@const opts = (() => { try { return JSON.parse(t.options || '[]'); } catch { return []; } })()}
              <div class="row row-q">
                <span class="row-ic"><Icon name="question" size={16} /></span>
                <div class="row-main">
                  <a class="row-title" href="/task/{t.id}">{t.title}</a>
                  <span class="row-sub"><span class="tasknum mono">#{t.id}</span><span class="dim mono">decision · agent blocked on you</span></span>
                  {#if opts.length}
                    <!-- task-359: exclusive answers → radiogroup tied to the question title -->
                    <div class="q-answer" role="radiogroup" aria-label="Answer: {t.title}" use:radioNav>
                      {#each opts as o}
                        <form method="POST" action="?/answer" use:enhance={answered(o.label)}>
                          <input type="hidden" name="id" value={t.id} /><input type="hidden" name="value" value={o.value} />
                          <button class="act act-decide" role="radio" aria-checked="false">{o.label}</button>
                        </form>
                      {/each}
                    </div>
                  {/if}
                </div>
                <span class="row-right">
                  {#if !opts.length}<a class="act act-decide" href="/task/{t.id}">Decide</a>{/if}
                </span>
              </div>
            {:else}
              <TaskRow task={t} project={projName(t.project_id)}>
                {#snippet actions()}<a class="act act-review" href="/task/{t.id}">Open</a>{/snippet}
              </TaskRow>
            {/if}
          {/each}
        </div>
      </section>
    {/if}

    <!-- IN FLIGHT -->
    {#if data.inFlight.length}
      <section class="lane lane-flight">
        <div class="lane-head">
          <span class="lane-ic"><Icon name="pulse" size={15} /></span>
          <h2>In flight</h2><span class="lane-count">{data.inFlight.length}</span>
        </div>
        <div class="list">
          {#each data.inFlight as t (t.id)}
            {@const who = String(t.claimed_by || t.assignee || '').toLowerCase()}
            {@const ag = fleetByHandle[who]}
            <div class="agent">
              <div class="ag-top">
                <span class="ag-dot" class:idle={!ag || ag.status !== 'working'}></span>
                <span class="ag-name mono">{who || 'unclaimed'}</span>
                {#if ag}<span class="ag-status">{ag.status}</span>{/if}
                {#if ag?.age_ms != null}<span class="ag-age mono">{fmtAge(ag.age_ms)}</span>{/if}
              </div>
              <a class="ag-body" href="/task/{t.id}">
                {#if ag?.status === 'working' && ag.current_tool}<span class="ag-tool mono" title={ag.current_tool}>{humanizeTool(ag.current_tool)}</span>{/if}
                <span class="ag-task">{t.title} <span class="tasknum mono">#{t.id}</span></span>
              </a>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    <!-- INBOX (folded into the desk; the standalone /inbox page is no longer needed for the daily view) -->
    {#if data.inbox?.length}
      <section class="lane lane-inbox">
        <div class="lane-head">
          <span class="lane-ic"><Icon name="inbox" size={15} /></span>
          <h2>Inbox</h2><span class="lane-count">{data.inbox.length}</span>
        </div>
        <div class="list">
          {#each data.inbox as t (t.id)}
            <TaskRow task={t} project={projName(t.project_id)} statusLabel="captured" />
          {/each}
        </div>
      </section>
    {/if}

    <!-- WHAT CHANGED TODAY -->
    {#if data.changedToday.length}
      <section class="lane">
        <div class="lane-head">
          <span class="lane-ic"><Icon name="clock" size={15} /></span>
          <h2>What changed today</h2><span class="lane-count">{data.changedToday.length}</span>
        </div>
        <div class="changed">
          {#each data.changedToday as c (c.id)}
            <a class="ch-item" href="/task/{c.id}">
              <b class="ok">closed</b>
              <span class="ch-id mono">#{c.id}</span>
              {#if c.by}<span class="ch-sep" aria-hidden="true">·</span><span class="ch-by mono dim">by {c.by}</span>{/if}
            </a>
          {/each}
        </div>
      </section>
    {/if}

  </div>

  {#if !data.onFire.length && !data.needsYou.length && !data.inFlight.length && !data.changedToday.length}
    <p class="all-clear mono">All clear — nothing on fire, nothing waiting on you. <a href="/browse">Browse the board →</a></p>
  {/if}

  <!-- one door to the firehose -->
  <a class="browse" href="/browse">
    <span class="bz-ic"><Icon name="board" size={20} /></span>
    <span class="bz-txt"><b>Browse all tasks</b><span>{g.backlog.total} open across every lane &amp; project</span></span>
    <span class="bz-go"><Icon name="arrow" size={18} /></span>
  </a>
</div>

<style>
  .cockpit { max-width: 1200px; }

  /* HUD header */
  .ckhead { margin-bottom: 8px; }
  .ckhead .greet { font-size: clamp(24px, 4vw, 30px); font-weight: 700; letter-spacing: -.025em; line-height: 1.15; }
  .ckhead .greet em { font-style: normal; color: var(--accent-b); }
  .statline { margin-top: 13px; display: flex; align-items: stretch; gap: 0; flex-wrap: wrap;
    border: 1px solid var(--border-sub); border-radius: var(--radius-lg); overflow: hidden; background: var(--surface-1); }
  .stat { display: flex; align-items: baseline; gap: 8px; padding: 11px 16px; flex: 1; min-width: 120px;
    border-right: 1px solid var(--border-sub); }
  .stat:last-child { border-right: 0; }
  .stat .n { font-size: 22px; font-weight: 600; line-height: 1; font-variant-numeric: tabular-nums; }
  .stat .l { font-size: 12px; color: var(--text-3); }
  .stat.you .n { color: var(--violet-b); }
  .stat.fire .n { color: var(--danger-b); }
  .stat.work .n { color: var(--accent-b); }

  .filters { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
  .fsel { display: flex; align-items: center; gap: 5px; background: var(--surface-1); border: 1px solid var(--border-sub);
    border-radius: var(--radius); padding: 0 10px; opacity: .82; }
  .fsel:hover { opacity: 1; }
  .fsel svg { color: var(--text-4); }
  .fsel select { border: 0; background: none; color: var(--text-3); font: inherit; font-size: 12.5px; padding: 6px 4px; cursor: pointer; outline: 0; }

  /* GRAPHS strip — flat (task-499, Bob: "all cards shall die"). No boxes: three columns
     in a single hairline-framed band, separated by vertical dividers + whitespace. */
  .graphs { display: grid; grid-template-columns: repeat(3, 1fr); margin-top: 18px;
    border-top: 1px solid var(--border-sub); border-bottom: 1px solid var(--border-sub); }
  .gcard { background: none; border: 0; border-radius: 0;
    padding: 16px 18px; display: flex; flex-direction: column; gap: 9px; min-width: 0; }
  .gcard + .gcard { border-left: 1px solid var(--border-sub); }
  .gcard:first-child { padding-left: 0; }
  .gcard:last-child { padding-right: 0; }
  .gc-head { display: flex; align-items: center; gap: 7px; font-family: var(--mono); font-size: 9.5px;
    text-transform: uppercase; letter-spacing: .11em; color: var(--text-4); }
  .gc-head .gc-ic { display: flex; color: var(--text-3); }

  .g-mom .mom-top { display: flex; align-items: baseline; gap: 8px; }
  .g-mom .mom-n { font-variant-numeric: tabular-nums; font-size: 38px; font-weight: 600; line-height: .92;
    color: var(--accent-b); letter-spacing: -.02em; }
  .g-mom .mom-unit { font-size: 12px; color: var(--text-3); }
  .g-mom .mom-chart { position: relative; margin-top: 1px; }
  .g-mom .spark { width: 100%; height: 30px; display: block; }
  .g-mom .spark-fill { fill: var(--accent-bg); }
  .g-mom .spark-base { stroke: var(--border-sub); stroke-width: 1; }
  .g-mom .spark-line { stroke: var(--accent-b); stroke-width: 1.6; stroke-linejoin: round; stroke-linecap: round; }
  /* interactive overlay: faint column rule + a marker dot at the active day */
  .g-mom .spark-rule { position: absolute; top: 0; bottom: 5px; width: 1px; transform: translateX(-50%);
    background: color-mix(in srgb, var(--accent-b) 38%, transparent); pointer-events: none; }
  .g-mom .spark-dot { position: absolute; width: 7px; height: 7px; border-radius: 50%;
    background: var(--accent-b); border: 1.5px solid var(--surface-1); transform: translate(-50%, -50%);
    pointer-events: none; }
  /* tap/hover columns — one per day, extended past the chart vertically for easy touch */
  .g-mom .mom-hits { position: absolute; inset: -7px 0 -7px 0; display: flex; }
  .g-mom .mom-hit { flex: 1; min-width: 0; padding: 0; border: 0; background: none; cursor: pointer; }
  /* no hover column fill — the line + active dot/rule are the readout (Bob: the bg was goofy) */
  .g-mom .mom-hit:focus-visible { outline: 2px solid var(--accent-b); outline-offset: -2px; }
  .g-mom .mom-cap { font-size: 11px; color: var(--text-4); line-height: 1.3; }

  .g-bl .bl-bar { display: flex; height: 13px; border-radius: 7px; overflow: hidden; background: var(--surface-3); }
  .g-bl .bl-seg { height: 100%; }
  .g-bl .bl-p0 { background: var(--danger); }
  .g-bl .bl-p1 { background: var(--warn); }
  .g-bl .bl-p2 { background: var(--text-4); }
  .g-bl .bl-p3 { background: var(--border); }
  .g-bl .bl-legend { display: grid; grid-template-columns: 1fr 1fr; gap: 3px 12px; margin-top: 1px; }
  .g-bl .bl-key { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-3); }
  .g-bl .bl-key .sw { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }
  .g-bl .bl-key .kc { margin-left: auto; font-variant-numeric: tabular-nums; font-size: 11px; color: var(--text-2); }
  .g-bl .bl-key.k0 .sw { background: var(--danger); } .g-bl .bl-key.k0 { color: var(--danger-b); }
  .g-bl .bl-key.k1 .sw { background: var(--warn); } .g-bl .bl-key.k1 { color: var(--warn-b); }
  .g-bl .bl-key.k2 .sw { background: var(--text-4); }
  .g-bl .bl-key.k3 .sw { background: var(--border); }

  .g-ring .ring-wrap { display: flex; align-items: center; gap: 14px; }
  .g-ring .ring { width: 84px; height: 84px; flex-shrink: 0; }
  .g-ring .ring-bg { fill: none; stroke: var(--surface-3); stroke-width: 9; }
  .g-ring .ring-seg { fill: none; stroke-width: 9; stroke-linecap: butt; }
  .g-ring .ring-ctr-n { font-variant-numeric: tabular-nums; font-size: 24px; font-weight: 600; fill: var(--text-1); }
  .g-ring .ring-legend { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
  .g-ring .ring-key { display: flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--text-3); }
  .g-ring .ring-key .sw { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .g-ring .ring-key b { font-variant-numeric: tabular-nums; color: var(--text-1); font-weight: 600; margin-right: 1px; }
  .g-ring .ring-key.ky .sw { background: var(--violet-b); }
  .g-ring .ring-key.kf .sw { background: var(--danger-b); }
  .g-ring .ring-key.kw .sw { background: var(--accent-b); }

  /* capture */
  .capture { display: flex; align-items: center; gap: 11px; background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-lg); padding: 0 14px; height: 48px; margin: 22px 0 0; transition: border-color .12s, box-shadow .12s; }
  .capture svg { color: var(--text-4); flex: none; }
  .capture input { flex: 1; border: 0; background: none; outline: 0; color: var(--text-1); font: inherit; font-size: 15px; }
  .capture:focus-within { border-color: var(--accent-ln); box-shadow: 0 0 0 3px var(--accent-bg); }
  .capture kbd { font-size: 11px; color: var(--text-4); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 2px 6px; }

  /* lanes */
  .lanes { display: flex; flex-direction: column; gap: 26px; margin-top: 26px; }
  .lane-head { display: flex; align-items: center; gap: 9px; margin-bottom: 11px; }
  .lane-head h2 { font-size: 12.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--text-2); }
  .lane-ic { display: flex; color: var(--text-3); }
  .lane-count { font-family: var(--mono); font-size: 11px; color: var(--text-3); background: var(--surface-2); padding: 1px 8px; border-radius: 10px; }

  .lane-you .lane-head h2, .lane-you .lane-ic { color: var(--violet-b); }
  .lane-fire .lane-head h2, .lane-fire .lane-ic { color: var(--danger-b); }
  .lane-flight .lane-head h2, .lane-flight .lane-ic { color: var(--accent-b); }
  .lane-inbox .lane-ic { color: var(--text-3); }

  /* flat list — rows separated by a single hairline, no per-row box (task-499) */
  .list { display: flex; flex-direction: column; gap: 0; }
  .list > * + * { border-top: 1px solid var(--border-sub); }

  .row { display: grid; grid-template-columns: auto 1fr auto; gap: 12px; align-items: center;
    padding: 13px 6px; background: none; border: 0; border-radius: 0;
    transition: background .12s; text-decoration: none; }
  .row:hover { background: var(--surface-1); }
  .row-ic { color: var(--text-3); display: flex; align-items: center; }
  .row-main { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .row-title { font-size: 14.5px; font-weight: 550; color: var(--text-1); line-height: 1.4; }
  .row-sub { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
  .tasknum { font-size: 10.5px; color: var(--text-4); }
  .dim { color: var(--text-3); }
  .row-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .row.row-q { align-items: flex-start; }
  .row.row-q .row-ic { padding-top: 2px; }

  /* NEEDS YOU: violet cue (carried by the row icon, not a side stripe) + action pills */
  .lane-you .row-ic { color: var(--violet-b); }
  .act { font-family: var(--mono); font-size: 10.5px; font-weight: 600; text-transform: uppercase;
    letter-spacing: .04em; padding: 5px 11px; border-radius: var(--radius-sm); white-space: nowrap;
    border: 1px solid transparent; transition: .12s; cursor: pointer; }
  .act-decide { background: var(--violet-bg); color: var(--violet-b); border-color: var(--violet-ln); }
  .act-decide:hover { background: var(--violet-bg); border-color: var(--violet); }
  .act-review { background: var(--accent-bg); color: var(--accent-b); border-color: var(--accent-ln); }
  .act-review:hover { border-color: var(--accent); }
  .q-answer { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin-top: 8px; }
  .q-answer form { display: flex; }

  /* ON FIRE: danger cue carried by the icon + count chip (no side stripe, no edge wash) */
  .lane-fire .lane-count { background: var(--danger-bg, rgba(220,38,38,.16)); color: var(--danger-b); }
  .lane-fire .lane-ic svg { animation: ember 2.6s ease-in-out infinite; }
  @keyframes ember { 0%, 100% { opacity: .85; } 50% { opacity: 1; } }

  /* IN FLIGHT — flat rows (task-499), same hairline-separated list as the others */
  .agent { display: flex; flex-direction: column; gap: 6px; padding: 13px 6px; border-radius: 0;
    transition: background .12s; }
  .agent:hover { background: var(--surface-1); }
  .ag-top { display: flex; align-items: center; gap: 8px; }
  .ag-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--violet-b);
    animation: ckpulse 1.8s infinite; flex-shrink: 0; }
  .ag-dot.idle { background: var(--text-4); box-shadow: none; animation: none; }
  .ag-name { font-size: 13px; font-weight: 600; color: var(--accent-b); }
  .ag-status { font-size: 9px; text-transform: uppercase; letter-spacing: .05em; padding: 1px 7px; border-radius: 5px;
    background: var(--accent-bg); color: var(--accent-b); font-family: var(--mono); }
  .ag-age { margin-left: auto; font-size: 9.5px; color: var(--text-4); }
  .ag-body { display: flex; align-items: center; gap: 9px; text-decoration: none; }
  .ag-tool { font-size: 10px; color: var(--text-1); padding: 1px 7px; border-radius: 5px;
    background: var(--accent-bg); border: 1px solid var(--accent-ln); flex-shrink: 0; }
  .ag-task { font-size: 13.5px; color: var(--text-2); min-width: 0; }
  .ag-task .tasknum { font-size: 10.5px; }

  /* WHAT CHANGED — flat (task-499): no outer box; each close is a quiet borderless tag */
  .changed { display: flex; flex-wrap: wrap; gap: 7px; padding: 2px 0; font-size: 13px; color: var(--text-3); }
  .changed .ch-item { display: inline-flex; align-items: baseline; gap: 6px; text-decoration: none;
    padding: 4px 10px; border-radius: var(--radius-sm); background: var(--surface-2); }
  .changed .ch-item:hover { background: var(--surface-3); }
  .changed .ch-item:hover b { text-decoration: underline; }
  .changed b { font-weight: 600; }
  .changed .ok { color: var(--violet-b); }
  .changed .ch-id { font-size: 11.5px; color: var(--text-2); }
  .changed .ch-sep { color: var(--text-4); }
  .changed .ch-by { font-size: 11.5px; }

  .all-clear { margin-top: 26px; padding: 20px; text-align: center; font-size: 13px; color: var(--text-3);
    border: 1px dashed var(--border); border-radius: var(--radius-lg); }
  .all-clear a { color: var(--accent-b); }

  /* browse door */
  .browse { display: flex; align-items: center; gap: 12px; margin-top: 26px; padding: 15px 18px;
    background: var(--surface-1); border: 1px dashed var(--border); border-radius: var(--radius-lg); transition: .12s; }
  .browse:hover { border-color: var(--text-4); background: var(--surface-2); }
  .browse .bz-ic { display: flex; color: var(--text-3); }
  .browse .bz-txt { display: flex; flex-direction: column; gap: 2px; }
  .browse .bz-txt b { font-size: 14px; font-weight: 600; color: var(--text-1); }
  .browse .bz-txt span { font-size: 12px; color: var(--text-4); }
  .browse .bz-go { margin-left: auto; color: var(--text-4); display: flex; }

  @keyframes ckpulse { 50% { opacity: .4; } }

  /* phone: graphs stack one-per-row (mirror the board's 760px container query);
     dividers go horizontal and padding evens out so each row reads cleanly */
  @container app (max-width: 760px) {
    .graphs { grid-template-columns: 1fr; }
    .gcard { padding: 15px 0; }
    .gcard + .gcard { border-left: 0; border-top: 1px solid var(--border-sub); }
  }
</style>
