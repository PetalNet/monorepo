import { openQuestions, answeredQuestions, inboxCounts, listProjects } from '$lib/server/db.js';

function parseOpts(s) { try { return JSON.parse(s || '[]'); } catch { return []; } }

export function load({ locals }) {
  const me = locals.user;
  const c = inboxCounts(me) || {};
  return {
    open: openQuestions(null, me, null).map((q) => ({ ...q, opts: parseOpts(q.options) })),
    answered: answeredQuestions(me).map((q) => ({ ...q, opts: parseOpts(q.options) })),
    counts: { open: c.open || 0, answered: c.answered || 0, docs: c.docs || 0, doing: c.doing || 0 },
    projects: listProjects(me)
  };
}

export const actions = {
  // answer an open question right from the hub
  answer: async ({ request }) => {
    const { answerQuestion } = await import('$lib/server/db.js');
    const f = await request.formData();
    answerQuestion(Number(f.get('id')), String(f.get('value') || ''));
    return { ok: true };
  }
};
