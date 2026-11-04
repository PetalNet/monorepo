import { error } from '@sveltejs/kit';
import { getProject, tasksInProject, deepScrub } from '$lib/server/db.js';

// Project drill-in: all of one project's items, grouped by status lane.
// Visibility mirrors listProjects (the /projects gate): a HUMAN may only open a project
// that's shared or their own private one. A private project they don't own 404s — same as
// the task detail page, so we never reveal a private project's existence. Item-level
// visibility is enforced again in tasksInProject (vis(me)), so a shared project never
// leaks another user's private task inside it.
export function load({ params, locals }) {
  const me = locals.user;
  const id = Number(params.id);
  const project = getProject(id);
  if (!project) throw error(404, 'No such project');
  // Fail closed: only a shared project, or my own, is visible. This also covers a
  // private project with an empty/null owner (which the old owner-guard let leak).
  if (!(project.visibility === 'shared' || project.owner === me)) {
    throw error(404, 'No such project'); // don't reveal a non-visible project's existence
  }
  return deepScrub({ project, tasks: tasksInProject(id, me), me });
}
