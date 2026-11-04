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
  import { statusClass, kindIcon } from '$lib/status.js';
  import { who } from '$lib/people.js';

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

  // LEFT indicator = our own kind icon (idea/question/doc/task), TINTED by status —
  // shape conveys kind (so ideas/docs read distinctly), colour conveys state. NOT
  // GitHub's open-circle/closed-check (Bob: "a circle doesn't mean issue, it's copycat").
  const ico = $derived(kindIcon(task?.kind));
  const sCls = $derived(statusClass(task?.status));
  const isDone = $derived(dim || task?.status === 'done' || task?.status === 'dropped');
  const link = $derived(href ?? `/task/${task?.id}`);
  const relTime = $derived(time ?? (showTime ? rel(task?.updated_at ?? task?.created_at) : ''));
  const statusTxt = $derived(statusLabel ?? (showStatus ? (task?.status ?? '') : ''));
  const asg = $derived(showAssignee ? who(task?.assignee) : '');
  // priority is a FIELD — it lives in the meta line below, not as a title-line pill (Bob).
  const prio = $derived(task?.priority);
  const metaParts = $derived(
    [statusTxt, showProject ? project : '', asg, relTime].filter(Boolean)
  );
</script>

<div class="trow" class:done={isDone}>
  <a class="trow-link" href={link}>
    <span class="trow-state st-{sCls}" title="{task?.kind ?? 'task'} · {task?.status}"><Icon name={ico} size={16} /></span>
    <span class="trow-main">
      <span class="trow-titleline">
        <span class="trow-title">{task?.title}</span>
        <span class="trow-num mono">#{task?.id}</span>
      </span>
      {#if metaParts.length || prio != null || metaSnippet}
        <span class="trow-meta mono">
          {#each metaParts as m, i}{#if i > 0}<span class="sep" aria-hidden="true">·</span>{/if}<span>{m}</span>{/each}
          {#if prio != null}<span class="sep" aria-hidden="true">·</span><span class="trow-prio p{prio}">P{prio}</span>{/if}
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
  /* kind icon tinted by state — intuitive hues (green = done, not GitHub's green = open) */
  .st-todo { color: #94a3b8; }
  .st-doing { color: var(--accent-b); }
  .st-review { color: #5eead4; }
  .st-blocked { color: var(--danger-b); }
  .st-done { color: #34d399; }
  .st-dropped { color: var(--text-4); }

  .trow-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .trow-titleline { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .trow-title { font-size: 14.5px; font-weight: 600; color: var(--text-1); line-height: 1.4;
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .trow:hover .trow-title { color: var(--accent-b); }
  .trow.done .trow-title { text-decoration: line-through; text-decoration-color: var(--text-4); font-weight: 550; }

  /* the #number trails to the end of the title line, muted (Bob) */
  .trow-num { margin-left: auto; flex-shrink: 0; font-size: 11.5px; color: var(--text-4); letter-spacing: -.01em; }

  /* priority — a FIELD in the meta line: P0/P1 coloured, P2/P3 muted like the rest */
  .trow-prio { font-weight: 700; letter-spacing: .02em; color: var(--text-4); }
  .trow-prio.p0 { color: var(--danger-b); }
  .trow-prio.p1 { color: var(--warn-b); }

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
