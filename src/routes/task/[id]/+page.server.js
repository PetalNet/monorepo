import { error } from '@sveltejs/kit';
import { marked } from 'marked';
import { getTask, listComments, children, listProjects, updateTask, addComment, answerQuestion } from '$lib/server/db.js';

export function load({ params, locals }) {
  const id = Number(params.id);
  const task = getTask(id);
  if (!task) throw error(404, 'No such task');
  if (task.visibility === 'private' && task.owner && task.owner !== locals.user) throw error(404, 'No such task'); // private = owner-only (404, don't reveal existence)
  let opts = [];
  try { opts = JSON.parse(task.options || '[]'); } catch { opts = []; }
  return {
    task,
    bodyHtml: task.body ? marked.parse(task.body, { breaks: true }) : '',
    opts,
    comments: listComments(id),
    kids: children(id),
    projects: listProjects(),
    me: locals.user
  };
}

export const actions = {
  // edit title / plan (body) / status / priority / blocked_on
  save: async ({ request, params, locals }) => {
    const f = await request.formData();
    const patch = {};
    for (const k of ['title', 'body', 'status', 'priority', 'blocked_on', 'assignee', 'capability', 'acceptance_criteria', 'handoff_context']) {
      if (f.has(k)) patch[k] = k === 'priority' ? Number(f.get(k)) : String(f.get(k));
    }
    patch.visibility = f.get('private') ? 'private' : 'shared';
    if (f.get('private')) patch.owner = locals.user;   // claim ownership when locking it down
    updateTask(Number(params.id), patch);
    return { ok: true };
  },
  answer: async ({ request, params }) => {
    const f = await request.formData();
    answerQuestion(Number(params.id), String(f.get('value') || ''));
    return { ok: true };
  },

  // append to the coordination log (agents drop research/findings here)
  comment: async ({ request, params, locals }) => {
    const f = await request.formData();
    const body = String(f.get('body') || '').trim();
    if (body) addComment(Number(params.id), locals.user || 'web', body);
    return { ok: true };
  }
};
