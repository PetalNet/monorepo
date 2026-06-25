import { error, fail } from '@sveltejs/kit';
import { renderMd } from '$lib/server/md.js';
import { getTask, listComments, children, childrenAll, parentOf, taskEvents, listProjects, updateTask, addComment, answerQuestion, canWrite, deepScrub, blockersOf, blocks, discoveredFrom, discoveries, closeTask } from '$lib/server/db.js';

// IDOR guard — a human may only mutate a task they can write (shared, or own private).
const gate = (id, me) => { if (!canWrite(id, me)) throw error(403, 'Not allowed'); };

// Pull a glossary out of a "## Glossary" / "## Definitions" section so the reader
// can hover-define jargon. Matches bullet lines like "- **Term** — definition"
// (em-dash, en-dash, hyphen, or colon as the separator).
function parseGlossary(md) {
  if (!md) return [];
  const lines = md.split('\n');
  let inSec = false;
  const out = [];
  const seen = new Set();
  for (const raw of lines) {
    const line = raw.trimEnd();
    const head = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (head) { inSec = /^(glossary|definitions|terms|jargon)\b/i.test(head[1].trim()); continue; }
    if (!inSec) continue;
    // - **Term** — definition   |   - Term: definition
    const m = line.match(/^\s*[-*]\s+(?:\*\*|__)?(.+?)(?:\*\*|__)?\s*(?:[—–:-]|--)\s+(.+)$/);
    if (m) {
      const term = m[1].replace(/[*_`]/g, '').trim();
      const def = m[2].replace(/[*_`]/g, '').trim();
      const key = term.toLowerCase();
      if (term && def && !seen.has(key)) { seen.add(key); out.push({ term, def }); }
    }
  }
  // longest first so multi-word terms win over their substrings when matching
  return out.sort((a, b) => b.term.length - a.term.length);
}

export function load({ params, locals }) {
  const id = Number(params.id);
  const task = getTask(id);
  if (!task) throw error(404, 'No such task');
  if (task.visibility === 'private' && task.owner && task.owner !== locals.user) throw error(404, 'No such task'); // private = owner-only (404, don't reveal existence)
  // options may be stored as bare strings (older questions) or {value,label} objects (newer).
  // Normalize to {value,label} so the one-tap pills always render a label — the answer value
  // stored is still the option's value/string, so the answer contract is unchanged.
  let opts = [];
  try {
    opts = JSON.parse(task.options || '[]').map((o) =>
      o && typeof o === 'object' ? { value: o.value ?? o.label ?? '', label: o.label ?? o.value ?? '' }
                                 : { value: String(o), label: String(o) }
    );
  } catch { opts = []; }
  return deepScrub({
    task,
    bodyHtml: renderMd(task.body),
    bodyHtmlHuman: renderMd(task.body_alt),
    // glossary lives in the humanized body_alt when present (sync-safe — the
    // Corner→tasks mirror overwrites body but never touches body_alt), else body
    glossary: parseGlossary(task.body_alt || task.body),
    opts,
    comments: listComments(id),
    kids: children(id, locals.user),  // me-scoped: don't leak private sub-tasks under a shared parent
    // hierarchy (first-class): ALL children incl. done/dropped + the parent up-link. Both
    // me-scoped so a private relative isn't revealed under a shared task.
    childrenAll: childrenAll(id, locals.user),
    parent: parentOf(id, locals.user),
    // activity timeline: audit events, parsed best-effort (data is the serialized JSON payload)
    events: taskEvents(id).map((e) => {
      let d = null;
      try { d = e.data ? JSON.parse(e.data) : null; } catch { d = null; }
      return { id: e.id, type: e.type, at: e.at, data: d };
    }),
    projects: listProjects(locals.user),  // me-scoped: don't leak private project names
    // fleet coordination spine (Phase 1): blocking deps (both directions) + non-blocking
    // discovered-from provenance. deepScrub strips claim_token from these task rows too.
    blockers: blockersOf(id, locals.user),          // me-scoped: don't leak a private blocker's title
    blocking: blocks(id, locals.user),              // me-scoped
    discoveredFrom: discoveredFrom(id, locals.user),// me-scoped provenance
    discoveries: discoveries(id, locals.user),      // me-scoped
    me: locals.user,
    // UI gate only — hides controls when the viewer can't write. The REAL boundary is the
    // gate() call inside every action; this just avoids showing dead buttons.
    canWrite: canWrite(id, locals.user)
  });
}

export const actions = {
  // edit title / plan (body) / status / priority / blocked_on
  save: async ({ request, params, locals }) => {
    gate(Number(params.id), locals.user);
    const f = await request.formData();
    const patch = {};
    for (const k of ['title', 'body', 'status', 'priority', 'blocked_on', 'assignee', 'responsible', 'capability', 'acceptance_criteria', 'handoff_context',
      'owner_machine', 'suggested_agent', 'effort', 'parallel_group']) {
      if (f.has(k)) patch[k] = k === 'priority' ? Number(f.get(k)) : String(f.get(k));
    }
    // only the full details form carries vis_touched — inline status/priority quick-edits must not reset visibility
    if (f.has('vis_touched')) {
      // Ownership/visibility may only be changed by the current owner, or claimed on an
      // UNOWNED task. Without this, any user could open a shared task someone else made,
      // flip it private + seize owner=self, and lock the creator out (privesc through canWrite).
      const cur = getTask(Number(params.id));
      if (!cur.owner || cur.owner === locals.user) {
        patch.visibility = f.get('private') ? 'private' : 'shared';
        if (f.get('private')) patch.owner = locals.user;   // claim ownership when locking it down
      }
    }
    updateTask(Number(params.id), patch);
    return { ok: true };
  },
  answer: async ({ request, params, locals }) => {
    gate(Number(params.id), locals.user);
    const f = await request.formData();
    answerQuestion(Number(params.id), String(f.get('value') || ''));
    return { ok: true };
  },

  // Claim — one-click "I'll take this": assign to the signed-in user + set status=todo so it's
  // queued to them. Same IDOR gate as every other mutation. (Distinct from the worker lease-claim
  // in db.js; this is the human "put it on my plate" action behind the action-bar button.)
  claim: async ({ params, locals }) => {
    gate(Number(params.id), locals.user);
    const me = locals.user || 'web';
    updateTask(Number(params.id), { assignee: me, status: 'todo' });
    return { ok: true };
  },

  // close a task WITH A MANDATORY reason (the "why" ledger — fleet-dispatcher Phase 1).
  // Rejects a blank reason (returns {ok:false} so the UI can show the requirement) and
  // stores it via the canonical closeTask (close_reason + tiny 'closed' event + cascade-unblock).
  close: async ({ request, params, locals }) => {
    gate(Number(params.id), locals.user);
    const f = await request.formData();
    const reason = String(f.get('reason') || '').trim();
    const status = f.get('status') === 'dropped' ? 'dropped' : 'done';
    const res = closeTask(Number(params.id), { reason, by: locals.user || 'web', status });
    if (res && res.ok === false) return fail(400, res);
    return { ok: true };
  },

  // append to the coordination log (agents drop research/findings here)
  comment: async ({ request, params, locals }) => {
    gate(Number(params.id), locals.user);
    const f = await request.formData();
    const body = String(f.get('body') || '').trim();
    if (body) addComment(Number(params.id), locals.user || 'web', body);
    return { ok: true };
  }
};
