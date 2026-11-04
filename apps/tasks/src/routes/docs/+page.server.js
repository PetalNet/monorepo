import { allDocs } from '$lib/server/db.js';

export function load({ locals }) {
  const docs = allDocs(locals.user);
  // group by project, preserving the (project-name, updated desc) order from the query
  const groups = [];
  const idx = new Map();
  for (const d of docs) {
    const key = d.project_name || '(no project)';
    let g = idx.get(key);
    if (!g) {
      g = { project: key, project_id: d.project_id, docs: [] };
      idx.set(key, g);
      groups.push(g);
    }
    g.docs.push(d);
  }
  return { groups, total: docs.length };
}
