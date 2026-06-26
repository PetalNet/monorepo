<script>
  // Shared task row — modern GitHub-issues presentation, used everywhere a task
  // appears (Desk lanes, search, browse, inbox). ONE place to change the look.
  //
  //   [state icon]  Title …………………… P0  #123
  //                 status · project · assignee · 2h        [actions]
  //
  // Flat (no per-row card box). The list that wraps these draws 1px hairline
  // separators; the row only owns a square (un-rounded) hover wash.
  import Icon from '$lib/Icon.svelte';

  let {
    task,                       // { id, title, kind, status, priority, project_id, assignee, created_at, updated_at, ... }
    project = '',               // project NAME (caller resolves id→name)
    href = undefined,           // defaults to /task/<id>
    showProject = true,
    showAssignee = true,
    showStatus = true,
    showTime = true,
    statusLabel = undefined,    // override the status word in the meta line (e.g. "captured")
    time = undefined,           // override the relative-time string
    dim = false,                // force the done/muted treatment
    actions = undefined,        // optional right-hand actions snippet (buttons/forms)
    meta: metaSnippet = undefined // optional extra meta snippet appended to the sub-line
  } = $props();

  const WHO = { alice: 'Alice', alice: 'Alice', bob: 'Bob', bob: 'Bob', bob: 'Bob', dev: 'dev' };
  const who = (a) => (a ? (WHO[String(a).toLowerCase()] ?? a) : '');

  function rel(ts) {
    if (!ts) return '';
    const iso = /[TZ]/.test(ts) ? ts : String(ts).replace(' ', 'T') + 'Z';
    const ms = new Date(iso).getTime();
    if (isNaN(ms)) return '';
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return s + 's';
    if (s < 3600) return Math.round(s / 60) + 'm';
    if (s < 86400) return Math.round(s / 3600) + 'h';
    if (s < 604800) return Math.round(s / 86400) + 'd';
    return Math.round(s / 604800) + 'w';
  }

  // status → GitHub-style state icon. open issue = open circle (green); closed =
  // filled check (purple). our extra states get restrained, distinct hues.
  const STATE = {
    done:    { icon: 'iclosed', cls: 'closed' },
    dropped: { icon: 'iclosed', cls: 'dropped' },
    blocked: { icon: 'iopen', cls: 'blocked' },
    doing:   { icon: 'iopen', cls: 'doing' },
    review:  { icon: 'iopen', cls: 'review' }
  };
  const state = $derived(STATE[task?.status] ?? { icon: 'iopen', cls: 'open' });
  const isDone = $derived(dim || task?.status === 'done' || task?.status === 'dropped');
  const link = $derived(href ?? `/task/${task?.id}`);
  const relTime = $derived(time ?? (showTime ? rel(task?.updated_at ?? task?.created_at) : ''));
  const statusTxt = $derived(statusLabel ?? (showStatus ? (task?.status ?? '') : ''));
  const asg = $derived(showAssignee ? who(task?.assignee) : '');
  const highPrio = $derived(task?.priority != null && task.priority <= 1);
  const metaParts = $derived(
    [statusTxt, showProject ? project : '', asg, relTime].filter(Boolean)
  );
</script>

<div class="trow" class:done={isDone}>
  <a class="trow-link" href={link}>
    <span class="trow-state st-{state.cls}" title={task?.status}><Icon name={state.icon} size={16} /></span>
    <span class="trow-main">
      <span class="trow-titleline">
        <span class="trow-title">{task?.title}</span>
        {#if highPrio}<span class="trow-prio p{task.priority}">P{task.priority}</span>{/if}
        <span class="trow-num mono">#{task?.id}</span>
      </span>
      {#if metaParts.length || metaSnippet}
        <span class="trow-meta mono">
          {#each metaParts as m, i}{#if i > 0}<span class="sep" aria-hidden="true">·</span>{/if}<span>{m}</span>{/each}
          {#if metaSnippet}{@render metaSnippet()}{/if}
        </span>
      {/if}
    </span>
  </a>
  {#if actions}<span class="trow-actions">{@render actions()}</span>{/if}
</div>

<style>
  /* flat row: no card, no rounded hover (Bob: rounded hover "feels goofy without cards") */
  .trow { display: flex; align-items: flex-start; gap: 10px; padding: 11px 10px;
    transition: background .12s; }
  .trow:hover { background: var(--surface-1); }
  .trow.done { opacity: .6; }
  .trow.done:hover { opacity: 1; }

  .trow-link { flex: 1; min-width: 0; display: flex; align-items: flex-start; gap: 12px; text-decoration: none; }
  .trow-state { display: flex; align-items: center; padding-top: 1px; flex-shrink: 0; }
  /* GitHub palette: open = green, closed = purple; our states restrained + distinct */
  .st-open { color: #34d399; }
  .st-doing { color: var(--accent-b); }
  .st-blocked { color: var(--danger-b); }
  .st-review { color: #5eead4; }
  .st-closed { color: #a78bfa; }
  .st-dropped { color: var(--text-4); }

  .trow-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .trow-titleline { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .trow-title { font-size: 14.5px; font-weight: 600; color: var(--text-1); line-height: 1.4;
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .trow:hover .trow-title { color: var(--accent-b); }
  .trow.done .trow-title { text-decoration: line-through; text-decoration-color: var(--text-4); font-weight: 550; }

  /* the #number trails to the end of the title line, muted (Bob) */
  .trow-num { margin-left: auto; flex-shrink: 0; font-size: 11.5px; color: var(--text-4); letter-spacing: -.01em; }

  /* priority pill — only shown for high priority (P0/P1) */
  .trow-prio { flex-shrink: 0; font-family: var(--mono); font-size: 10px; font-weight: 700;
    padding: 1px 6px; border-radius: 5px; letter-spacing: .03em; }
  .trow-prio.p0 { color: var(--danger-b); background: color-mix(in srgb, var(--danger) 16%, transparent); }
  .trow-prio.p1 { color: var(--warn-b); background: color-mix(in srgb, var(--warn) 16%, transparent); }

  /* one quiet meta sub-line, GitHub-style */
  .trow-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
    font-size: 11.5px; color: var(--text-4); line-height: 1.5; }
  .trow-meta .sep { opacity: .55; }

  .trow-actions { flex-shrink: 0; display: flex; align-items: center; gap: 7px; align-self: center; }

  /* phone: let long titles wrap (mirrors app.css .row-title override) */
  @container app (max-width: 760px) {
    .trow-title { white-space: normal; }
  }
</style>
