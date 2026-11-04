import { listArtifacts } from '$lib/server/db.js';

// Gallery index: metadata only (title, date, description, kind) — visibility-gated to
// the signed-in user. Content blobs are never loaded here; they're fetched per-page.
export function load({ locals }) {
  const artifacts = listArtifacts(locals.user);
  return { artifacts, me: locals.user };
}
