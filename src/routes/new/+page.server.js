import { redirect } from '@sveltejs/kit';
import { listProjects, ensureProject, createTask, createDoc, createQuestion, nextUpNextRank } from '$lib/server/db.js';

export function load() { return { projects: listProjects() }; }

export const actions = {
  create: async ({ request }) => {
    const f = await request.formData();
    const kind = String(f.get('kind') || 'task');
    const title = String(f.get('title') || '').trim();
    if (!title) return { ok: false };
    const projName = String(f.get('project') || '').trim();
    const pid = projName ? ensureProject(projName) : null;
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
    throw redirect(303, `/task/${id}`);
  }
};
