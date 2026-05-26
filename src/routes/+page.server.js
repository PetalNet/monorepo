import {
  upNext, inbox, backlog, listProjects, getProjectByName,
  createTask, updateTask, ensureProject, nextUpNextRank, getTask,
  listDocs, openQuestions, answerQuestion
} from '$lib/server/db.js';

export function load({ url }) {
  const projName = url.searchParams.get('project') || null;
  const proj = projName ? getProjectByName(projName) : null;
  const pid = proj?.id ?? null;
  return {
    projects: listProjects(),
    current: proj?.name ?? null,
    backend: proj?.backend ?? null,
    questions: openQuestions(pid).map((q) => ({ ...q, opts: parseOpts(q.options) })),
    upNext: upNext(pid),
    inbox: inbox(pid),
    backlog: backlog(pid),
    docs: listDocs(pid)
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
    updateTask(id, patch);
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
  }
};
