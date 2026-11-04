import { json } from '@sveltejs/kit';
import { handleAgentRpc, BODY_MAX } from '$lib/server/agent-api.js';

// POST /api/agent/rpc  { op, args } — bearer-token RPC for remote headless agents.
//
// This path is SSO-EXEMPT (hooks.server.js isAgentApi + Agent-a's Traefik `tasks-agent`
// router), so ALL access control lives in handleAgentRpc: fail-closed bearer auth,
// per-agent rate limiting, and scope confinement (a scoped token can only see/act on
// tasks in its own assignee/project lane). event.locals.user is intentionally unset
// here — identity resolves by token, never by header. The route stays a thin transport
// wrapper so scripts/test-agent-api.mjs can exercise the real handler under plain node.
export async function POST({ request }) {
  // reject oversized bodies before buffering them (the handler re-checks the real length)
  const len = Number(request.headers.get('content-length'));
  if (Number.isFinite(len) && len > BODY_MAX) return json({ error: 'body_too_large' }, { status: 413 });
  let rawBody;
  try { rawBody = await request.text(); } catch { rawBody = ''; }
  const { status, body } = handleAgentRpc({
    authorization: request.headers.get('authorization'),
    rawBody
  });
  return json(body, { status });
}
