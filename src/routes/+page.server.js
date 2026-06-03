import {
  upNext, inbox, backlog, listProjects, getProjectByName,
  createTask, updateTask, ensureProject, nextUpNextRank, getTask,
  listDocs, openQuestions, answerQuestion, listAssignees,
  blockedList, addBlocker, removeBlocker, unfinishedBlockers, blockerCandidates
} from '$lib/server/db.js';

export function load({ url, locals }) {
  const me = locals.user;                       // logged-in human; filters out others' private items
  const projName = url.searchParams.get('project') || null;
  const proj = projName ? getProjectByName(projName) : null;
  const pid = proj?.id ?? null;
  const who = url.searchParams.get('assignee') || null;   // assignee filter (combinable with project)
  return {
    projects: listProjects(me),
    current: proj?.name ?? null,
    backend: proj?.backend ?? null,
    me,
    assignees: listAssignees(me),
    assignee: who,
    questions: openQuestions(pid, me, who).map((q) => ({ ...q, opts: parseOpts(q.options) })),
    upNext: upNext(pid, me, who),
    inbox: inbox(pid, me, who),
    backlog: backlog(pid, me, who),
    blocked: blockedList(pid, me, who),
    candidates: blockerCandidates(me),
    docs: listDocs(pid, me, who)
  };
}

function parseOpts(s) { try { return JSON.parse(s || '[]'); } catch { return []; } }

export const actions = {
  // 2-second async capture → idea in the inbox
  capture: async ({ request }) => {
    const f = await request.formData();
    const title = String(f.get('title') || '').trim();
    if (!title) return { ok: false };
    const projName = String(f.get('project') || '').trim();
    const project_id = projName ? ensureProject(projName) : null;
    createTask({ title, kind: 'idea', project_id, created_by: 'web' });
    return { ok: true };
  },

  // break a task down into a sub-task (beads-style; child inherits the parent's project)
  subtask: async ({ request }) => {
    const f = await request.formData();
    const parent_id = Number(f.get('parent'));
    const title = String(f.get('title') || '').trim();
    if (!parent_id || !title) return { ok: false };
    const parent = getTask(parent_id);
    createTask({ title, kind: 'task', status: 'todo', parent_id, project_id: parent?.project_id ?? null, created_by: 'web' });
    return { ok: true };
  },

  update: async ({ request }) => {
    const f = await request.formData();
    const id = Number(f.get('id'));
    const patch = {};
    for (const k of ['status', 'priority', 'up_next', 'blocked_on', 'title']) {
      if (f.has(k)) patch[k] = (k === 'priority' || k === 'up_next') ? Number(f.get(k)) : String(f.get(k));
    }
    // a 'blocker' id may ride along when setting status=blocked, so the guard passes
    if (patch.status === 'blocked' && f.get('blocker')) addBlocker(id, Number(f.get('blocker')));
    const res = updateTask(id, patch);
    if (res && res.ok === false) return { ok: false, error: res.message };
    return { ok: true };
  },

  // add or remove a task-to-task blocker edge ("this is blocked BY that")
  blocker: async ({ request }) => {
    const f = await request.formData();
    const id = Number(f.get('id'));
    const blocker_id = Number(f.get('blocker_id'));
    const op = String(f.get('op') || 'add');
    if (!id || !blocker_id) return { ok: false };
    if (op === 'remove') removeBlocker(id, blocker_id);
    else {
      addBlocker(id, blocker_id);
      // adding a live blocker to an open task flips it to blocked
      if (unfinishedBlockers(id).length) updateTask(id, { status: 'blocked' });
    }
    return { ok: true };
  },

  // triage an inbox idea: up=Up Next, backlog, drop, or rank it up into its OWN project
  triage: async ({ request }) => {
    const f = await request.formData();
    const id = Number(f.get('id'));
    const to = String(f.get('to'));
    if (to === 'up')           updateTask(id, { kind: 'task', status: 'todo', up_next: 1, rank: nextUpNextRank() });
    else if (to === 'backlog') updateTask(id, { kind: 'task', status: 'todo', up_next: 0 });
    else if (to === 'drop')    updateTask(id, { status: 'dropped' });
    else if (to === 'project') {
      const name = String(f.get('name') || '').trim();
      if (name) updateTask(id, { kind: 'task', status: 'todo', project_id: ensureProject(name) });
    }
    return { ok: true };
  },

  // answer an async decision (Corner-style question)
  answer: async ({ request }) => {
    const f = await request.formData();
    answerQuestion(Number(f.get('id')), String(f.get('value') || ''));
    return { ok: true };
  },

  // assign/change a task's project from the per-task picker ("none" clears it)
  setproject: async ({ request }) => {
    const f = await request.formData();
    const id = Number(f.get('id'));
    const v = String(f.get('project_id') || '');
    if (!id || !v) return { ok: false };
    updateTask(id, { project_id: v === 'none' ? null : Number(v) });
    return { ok: true };
  }
};
