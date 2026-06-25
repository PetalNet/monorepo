import { error, fail } from '@sveltejs/kit';
import { renderMd } from '$lib/server/md.js';
import {
  getArtifact, createArtifactShare, listArtifactShares, revokeArtifactShare
} from '$lib/server/db.js';

// One artifact reader. getArtifact enforces the same visibility gate as the rest of
// tasks (private = owner-only) IN SQL, returning undefined for unknown OR forbidden
// slugs — so an outsider gets a uniform 404 that never reveals a private artifact's
// existence. Markdown is rendered server-side through the shared renderMd (which drops
// raw HTML at the parse boundary, then runs rehype-sanitize) so there is no stored-XSS
// path. HTML artifacts are NOT inlined — the page embeds them in a locked-down sandbox
// iframe that pulls /gallery/[slug]/raw (see that route + the iframe sandbox attr).
export function load({ params, locals }) {
  const a = getArtifact(params.slug, locals.user);
  if (!a) throw error(404, 'No such artifact');
  return {
    slug: a.slug,
    title: a.title,
    description: a.description,
    kind: a.kind,
    source: a.source,
    updated_at: a.updated_at,
    // only markdown artifacts are rendered here; html ones load via the sandboxed iframe
    bodyHtml: a.kind === 'markdown' ? renderMd(a.content) : '',
    // existing share-links for THIS artifact (metadata only — never the token/hash)
    shares: listArtifactShares(a.slug),
    me: locals.user
  };
}

// Share-management gate: a human may mint/revoke a share for an artifact ONLY if they can SEE it
// (same predicate as the load gate — getArtifact with the signed-in user returns undefined for an
// unknown or forbidden slug). This sits behind the global Authentik gate already (hooks.server.js
// fail-closed), so an unauthenticated visitor can never reach these actions. Returns the artifact
// (proof the caller is authorized for this slug) or throws 403.
function gateShare(slug, me) {
  const a = getArtifact(slug, me);
  if (!a) throw error(403, 'Not allowed');
  return a;
}

export const actions = {
  // Mint a new scoped share-link. Returns the FULL link (token shown ONCE — never persisted raw).
  createShare: async ({ params, request, locals }) => {
    gateShare(params.slug, locals.user);
    const f = await request.formData();
    const label = String(f.get('label') || '').trim().slice(0, 200);
    // optional expiry: an <input type="datetime-local"> gives 'YYYY-MM-DDTHH:MM' in LOCAL time.
    // Convert to a UTC SQL timestamp ('YYYY-MM-DD HH:MM:SS') so the IS-expired check (datetime('now'),
    // which is UTC) compares apples to apples. Empty → no expiry (null). A bad/past value is rejected.
    let expires_at = null;
    const rawExp = String(f.get('expires_at') || '').trim();
    if (rawExp) {
      const d = new Date(rawExp); // parsed as local time by the JS engine
      if (isNaN(d.getTime())) return fail(400, { shareError: 'Invalid expiry date.' });
      if (d.getTime() <= Date.now()) return fail(400, { shareError: 'Expiry must be in the future.' });
      expires_at = d.toISOString().slice(0, 19).replace('T', ' '); // UTC 'YYYY-MM-DD HH:MM:SS'
    }
    let res;
    try {
      res = createArtifactShare({ slug: params.slug, label, created_by: locals.user || '', expires_at });
    } catch (e) {
      return fail(400, { shareError: 'Could not create share.' });
    }
    // The raw token is returned to the browser ONCE here so the UI can show + copy the link.
    // It is NOT stored (only its sha256 is). After this response it's unrecoverable by design.
    return { shareCreated: true, token: res.token, expires_at: res.expires_at };
  },

  // Revoke a share (sets revoked=1). Scoped to this artifact's slug so an id alone can't kill
  // another artifact's link. Idempotent.
  revokeShare: async ({ params, request, locals }) => {
    gateShare(params.slug, locals.user);
    const f = await request.formData();
    const id = Number(f.get('id'));
    if (!id) return fail(400, { shareError: 'Missing share id.' });
    revokeArtifactShare(id, params.slug);
    return { shareRevoked: true };
  }
};
