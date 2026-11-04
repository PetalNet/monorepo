import { error, fail } from '@sveltejs/kit';
import { getMockSession, recordMockChoice } from '$lib/server/db.js';

// A mock session = a decision layer over the gallery. The page renders each option's gallery
// design in the locked sandbox iframe; the choose controls are HERE on the trusted outer page.
export function load({ params, locals }) {
  const s = getMockSession(params.token);
  if (!s) throw error(404, 'No such mock session');
  return {
    token: s.token,
    title: s.title,
    spec: s.spec,
    results: s.results,
    status: s.status,
    me: locals.user
  };
}

export const actions = {
  // Record one question's pick. Gated on an authenticated identity (fail-closed); the data op
  // validates the choice against the session's real options.
  choose: async ({ request, params, locals }) => {
    const fd = await request.formData();
    const questionId = String(fd.get('questionId') || '');
    const choice = String(fd.get('choice') || '');
    const choices = fd.getAll('choices').map((c) => String(c)); // multi-select questions
    const comment = String(fd.get('comment') || '');
    // questionId is attached to every failure so the UI can surface it on the right question.
    if (!locals.user) return fail(401, { error: 'Sign-in required to record a choice.', questionId });
    if (!choice && choices.length === 0) return fail(400, { error: 'Pick at least one option first.', questionId });
    try {
      recordMockChoice({ token: params.token, questionId, choice, choices, comment, me: locals.user });
    } catch (e) {
      return fail(400, { error: e.message, questionId });
    }
    return { ok: true, questionId };
  }
};
