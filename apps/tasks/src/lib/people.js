// Single source of truth for handle → display name (#503 — was duplicated across
// TaskRow.svelte, SearchBox.svelte, +layout.svelte and +page.svelte).
//
// Real people only. The local-dev fallback identity 'dev' is intentionally NOT in
// the map because its rendering is context-dependent: the account chrome shows
// 'dev' verbatim, the desk greeting says 'there' ("Good morning, there"). Each
// caller of displayName() passes the label it wants for that fallback.
let people = {};

export function setPeople(entries = {}) {
	people = {};

	for (const [handle, entry] of Object.entries(entries)) {
		people[handle.toLowerCase()] = entry;

		for (const alias of entry.aliases || []) {
			people[alias.toLowerCase()] = entry;
		}
	}
}

// displayName(handle, devLabel): current-signed-in-user display (greeting / account).
// known handle → person name; unknown handle → Capitalized handle; the 'dev'
// fallback identity → caller-supplied devLabel ('dev' for account, 'there' for greeting).
export function displayName(handle, devLabel = "dev") {
	const h = String(handle || "dev").toLowerCase();

	if (h === "dev") {
		return devLabel;
	}

	return people[h]?.name ?? h.charAt(0).toUpperCase() + h.slice(1);
}
