// Single source of truth for handle → display name (#503 — was duplicated across
// TaskRow.svelte, SearchBox.svelte, +layout.svelte and +page.svelte).
//
// Real people only. The local-dev fallback identity 'dev' is intentionally NOT in
// the map because its rendering is context-dependent: the account chrome shows
// 'dev' verbatim, the desk greeting says 'there' ("Good morning, there"). Each
// caller of displayName() passes the label it wants for that fallback.
export const WHO = {
	alice: "Alice",
	alice: "Alice",
	bob: "Bob",
	bob: "Bob",
	bob: "Bob",
};

// who(handle): inline / assignee display. Empty handle → '' (render nothing);
// known handle → person name; unknown handle → the raw handle unchanged.
export function who(handle) {
	if (!handle) return "";
	return WHO[String(handle).toLowerCase()] ?? handle;
}

// displayName(handle, devLabel): current-signed-in-user display (greeting / account).
// known handle → person name; unknown handle → Capitalized handle; the 'dev'
// fallback identity → caller-supplied devLabel ('dev' for account, 'there' for greeting).
export function displayName(handle, devLabel = "dev") {
	const h = String(handle || "dev").toLowerCase();
	if (h === "dev") return devLabel;
	return WHO[h] ?? h.charAt(0).toUpperCase() + h.slice(1);
}

// projectName(projects) → (id) → project name (#503 follow-up — the
// `(id)=>data.projects.find(p=>p.id===id)?.name ?? ''` resolver was duplicated across
// the Desk, browse, board, inbox, issues and task/[id] pages). It can't be a constant
// because it closes over the page's loaded `data.projects`, so it's a tiny factory:
// each consumer builds `const projName = projectName(data.projects)`.
export const projectName = (projects) => (id) => projects.find((p) => p.id === id)?.name ?? "";

// PERSON: handle → avatar/agent swatch (#503 follow-up — whoColor was duplicated across
// board, issues, projects, project/[id] and task/[id]). This map is the UNION of all five
// prior copies; no key had a conflicting value, and none of the keys that only some copies
// carried (codex/agent-d/agent-e/web/alice/bob) is hit by any handle in the data, so
// the union changes no rendered color for any existing input.
export const PERSON = {
	claude: "#fb923c",
	agent-a: "#8b5cf6",
	agent-b: "#22d3ee",
	alice: "#fb7185",
	alice: "#fb7185",
	alice: "#fb7185",
	bob: "#38bdf8",
	bob: "#38bdf8",
	bob: "#38bdf8",
	codex: "#a3e635",
	agent-d: "#f472b6",
	agent-e: "#facc15",
	web: "#94a3b8",
};

const personHue = (s) => {
	let h = 0;
	for (let i = 0; i < (s?.length ?? 0); i++) h = (h * 31 + s.charCodeAt(i)) % 360;
	return h;
};

// whoColor(handle, empty): named swatch → deterministic hashed hsl → `empty` for a falsy
// handle. The falsy-handle fallback was the ONE genuine divergence between the prior copies
// (issues + task/[id] used 'var(--text-3)', board used '#94a3b8', projects + project/[id]
// used null), so it stays a per-caller argument — `empty` defaults to 'var(--text-3)' and
// each page that differed binds its own value, preserving every call site's exact output.
export const whoColor = (handle, empty = "var(--text-3)") =>
	handle ? (PERSON[String(handle).toLowerCase()] ?? `hsl(${personHue(handle)} 60% 68%)`) : empty;
