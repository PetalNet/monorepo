import { redirect } from '@sveltejs/kit';
import { listProjects, ensureProject, defaultProjectId, createTask, createDoc, createQuestion, updateTask, nextUpNextRank } from '$lib/server/db.js';

export function load({ locals }) { return { projects: listProjects(locals.user) }; }

export const actions = {
  create: async ({ request, locals }) => {
    const f = await request.formData();
    const kind = String(f.get('kind') || 'task');
    const title = String(f.get('title') || '').trim();
    if (!title) return { ok: false };
    const projName = String(f.get('project') || '').trim();
    // INVARIANT (Bob, repeatedly): a TASK must have an EXPLICITLY-chosen parent project — no silent
    // catch-all fallback that lets a project-less task slip through. (createTask also hard-rejects
    // kind=task w/o project_id as the structural backstop.) Ideas/docs/questions may still fall back.
    if (kind === 'task' && !projName) return { ok: false, error: 'Pick a parent project — a task needs one.' };
    const pid = projName ? ensureProject(projName) : defaultProjectId();
    const body = String(f.get('body') || '');
    let id;
    if (kind === 'doc') {
      id = createDoc(pid, title, body, 'web');
    } else if (kind === 'question') {
      const options = String(f.get('options') || '').split('\n').map((s) => s.trim()).filter(Boolean).map((line) => {
        const i = line.indexOf('|');
        return i >= 0
          ? { value: line.slice(0, i).trim(), label: line.slice(i + 1).trim() }
          : { value: line.toLowerCase().replace(/\s+/g, '-').slice(0, 40), label: line };
      });
      id = createQuestion(pid, title, body, options, 'web');
    } else {
      const up = f.get('up_next') ? 1 : 0;
      id = createTask({
        kind: 'task', title, body, status: 'todo',
        priority: Number(f.get('priority') ?? 2),
        project_id: pid, up_next: up, rank: up ? nextUpNextRank() : 0, created_by: 'web'
      });
    }
    updateTask(id, { owner: locals.user, visibility: f.get('private') ? 'private' : 'shared' });
    throw redirect(303, `/task/${id}`);
  }
};
