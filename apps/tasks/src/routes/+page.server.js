import { error } from '@sveltejs/kit';
import {
  cockpitData, listProjects, listAssignees, deepScrub,
  ensureProject, createTask, updateTask, answerQuestion, canWrite, inbox
} from '$lib/server/db.js';
import { getFleet } from '$lib/server/fleet.js';

// IDOR guard: a human may only mutate tasks they can write (shared, or their own private).
const gate = (id, me) => { if (!canWrite(id, me)) throw error(403, 'Not allowed'); };

// /  — the OWNER COCKPIT. The firehose board moved to /browse; this is the
// attention-first landing: on-fire P0s, what needs YOU, what's in flight (joined
// to the live fleet), what changed today, and the glance-layer graphs.
export function load({ locals }) {
  const me = locals.user;
  const fleet = getFleet(me);                 // live per-agent telemetry (data/fleet/*.json)
  const data = cockpitData(me, { workingAgents: fleet.totals?.working ?? 0 });
  return deepScrub({
    ...data,
    fleet,                                     // for the in-flight lane's live agent join
    inbox: inbox(null, me, null),              // captured ideas (folded into the desk; same vis-gating)
    projects: listProjects(me),                // project-name lookup + filter dropdown
    assignees: listAssignees(me),
    me
  });
}

export const actions = {
  // capture from the cockpit (parity with the board) → idea in the inbox
  capture: async ({ request }) => {
    const f = await request.formData();
    const title = String(f.get('title') || '').trim();
    if (!title) return { ok: false };
    const projName = String(f.get('project') || '').trim();
    const project_id = projName ? ensureProject(projName) : null;
    createTask({ title, kind: 'idea', project_id, created_by: 'web' });
    return { ok: true };
  },

  // mark a task done from a cockpit lane
  update: async ({ request, locals }) => {
    const f = await request.formData();
    const id = Number(f.get('id'));
    gate(id, locals.user);
    const patch = {};
    if (f.has('status')) patch.status = String(f.get('status'));
    const res = updateTask(id, patch);
    if (res && res.ok === false) return { ok: false, error: res.message };
    return { ok: true };
  },

  // answer an open question/decision inline from NEEDS YOU
  answer: async ({ request, locals }) => {
    const f = await request.formData();
    const id = Number(f.get('id'));
    gate(id, locals.user);
    answerQuestion(id, String(f.get('value') || ''));
    return { ok: true };
  }
};
