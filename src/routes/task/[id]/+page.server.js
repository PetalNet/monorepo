import { error } from '@sveltejs/kit';
import { renderMd } from '$lib/server/md.js';
import { getTask, listComments, children, listProjects, updateTask, addComment, answerQuestion, canWrite, deepScrub } from '$lib/server/db.js';

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
  let opts = [];
  try { opts = JSON.parse(task.options || '[]'); } catch { opts = []; }
  return deepScrub({
    task,
    bodyHtml: renderMd(task.body),
    bodyHtmlHuman: renderMd(task.body_alt),
    // glossary lives in the humanized body_alt when present (sync-safe — the
    // Corner→tasks mirror overwrites body but never touches body_alt), else body
    glossary: parseGlossary(task.body_alt || task.body),
    opts,
    comments: listComments(id),
    kids: children(id),
    projects: listProjects(locals.user),  // me-scoped: don't leak private project names
    me: locals.user
  });
}

export const actions = {
  // edit title / plan (body) / status / priority / blocked_on
  save: async ({ request, params, locals }) => {
    gate(Number(params.id), locals.user);
    const f = await request.formData();
    const patch = {};
    for (const k of ['title', 'body', 'status', 'priority', 'blocked_on', 'assignee', 'responsible', 'capability', 'acceptance_criteria', 'handoff_context']) {
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

  // append to the coordination log (agents drop research/findings here)
  comment: async ({ request, params, locals }) => {
    gate(Number(params.id), locals.user);
    const f = await request.formData();
    const body = String(f.get('body') || '').trim();
    if (body) addComment(Number(params.id), locals.user || 'web', body);
    return { ok: true };
  }
};
