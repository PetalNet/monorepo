// Single source of truth for handle → display name (#503 — was duplicated across
// TaskRow.svelte, SearchBox.svelte, +layout.svelte and +page.svelte).
//
// Real people only. The local-dev fallback identity 'dev' is intentionally NOT in
// the map because its rendering is context-dependent: the account chrome shows
// 'dev' verbatim, the desk greeting says 'there' ("Good morning, there"). Each
// caller of displayName() passes the label it wants for that fallback.
export const WHO = {
  alice: 'Alice',
  alice: 'Alice',
  bob: 'Bob',
  bob: 'Bob',
  bob: 'Bob'
};

// who(handle): inline / assignee display. Empty handle → '' (render nothing);
// known handle → person name; unknown handle → the raw handle unchanged.
export function who(handle) {
  if (!handle) return '';
  return WHO[String(handle).toLowerCase()] ?? handle;
}

// displayName(handle, devLabel): current-signed-in-user display (greeting / account).
// known handle → person name; unknown handle → Capitalized handle; the 'dev'
// fallback identity → caller-supplied devLabel ('dev' for account, 'there' for greeting).
export function displayName(handle, devLabel = 'dev') {
  const h = String(handle || 'dev').toLowerCase();
  if (h === 'dev') return devLabel;
  return WHO[h] ?? h.charAt(0).toUpperCase() + h.slice(1);
}
