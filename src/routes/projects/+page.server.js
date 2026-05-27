import db, { listProjects, getProject, renameProject, setProjectVisibility, deleteProject } from '$lib/server/db.js';

export function load({ locals }) {
  const me = locals.user;
  const projects = listProjects(me).map((p) => ({
    ...p,
    count: db.prepare("SELECT count(*) c FROM tasks WHERE project_id=? AND status NOT IN ('done','dropped')").get(p.id).c
  }));
  return { projects, me };
}

// only act on a project the user can actually see (shared or owned)
const allowed = (id, me) => {
  const p = getProject(id);
  return p && (p.visibility === 'shared' || p.owner === me) ? p : null;
};

export const actions = {
  rename: async ({ request, locals }) => {
    const f = await request.formData();
    const id = Number(f.get('id'));
    const name = String(f.get('name') || '').trim();
    if (name && allowed(id, locals.user)) renameProject(id, name);
    return { ok: true };
  },
  visibility: async ({ request, locals }) => {
    const f = await request.formData();
    const id = Number(f.get('id'));
    if (!allowed(id, locals.user)) return { ok: false };
    const priv = !!f.get('private');
    setProjectVisibility(id, priv ? 'private' : 'shared', priv ? locals.user : '');
    return { ok: true };
  },
  delete: async ({ request, locals }) => {
    const f = await request.formData();
    const id = Number(f.get('id'));
    if (allowed(id, locals.user)) deleteProject(id);
    return { ok: true };
  }
};
