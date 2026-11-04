import { json } from '@sveltejs/kit';
import { searchIndex } from '$lib/server/db.js';

// Lightweight, visibility-gated search index for the top-bar typeahead. Fetched once
// per session on first focus; the client fuzzy-ranks it locally for instant results.
export function GET({ locals }) {
  const items = searchIndex(locals.user);
  return json(
    { items },
    { headers: { 'cache-control': 'private, max-age=20' } }
  );
}
