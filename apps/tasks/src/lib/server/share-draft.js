// Draft autosave for ONE public share link: GET/PUT /s/<token>/draft.
//
// An interactive artifact served at /s/<token> runs in an opaque-origin sandbox, so it has no
// localStorage and no network. A share can opt in (artifact_shares.draft_enabled=1) to a single
// save slot, so the visitor's edits survive closing the tab and the owner can read the latest
// draft on the SSO-gated gallery page.
//
// Threat model: this is an SSO-EXEMPT WRITE path, authenticated only by the share token.
//  - Scope: a valid, unrevoked, unexpired, draft-enabled token reads and writes ONLY its own
//    share_drafts rows. It never touches artifacts, tasks or any other share.
//  - Any token miss (unknown, revoked, expired, drafts off, non-interactive artifact) is the same
//    generic 404 the /s/ route uses.
//  - Bounded: body capped at BODY_MAX (413, checked before the token so it reveals nothing),
//    strict schema (400), per-IP and per-share rate limits (429), and SHARE_DRAFT_KEEP revisions.
//  - No cookies: responses allow any origin WITHOUT credentials. The page's origin is opaque
//    ("null") and nothing here reads an identity.
//  - The draft is stored as JSON text and only ever rendered as plain text (textarea values on the
//    share page, an escaped <pre> on the gallery page).
import { getLatestShareDraft, resolveShare, saveShareDraft } from "./db.js";
import { take } from "./ratelimit.js";

export const BODY_MAX = 32 * 1024;
const MAX_PARAS = 10;
const MAX_PARA_CHARS = 8000;
const TOKEN_RE = /^[\w-]{16,128}$/;
const ORIGIN_RE = /^https:\/\/[a-z0-9.-]+(?::\d+)?$/;

// Per IP: 30 requests a minute. Per share: 20 a minute (autosave fires at most every 1.5 s).
const IP_LIMIT = { capacity: 30, rate: 0.5 };
const SHARE_LIMIT = { capacity: 20, rate: 1 / 3 };

// CSP for /s/<token>. A share without drafts gets EXACTLY these strings (a test pins them byte for
// byte). A draft-enabled interactive share gets one extra directive naming its own draft URL.
export const SHARE_CSP = {
	html: "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; frame-ancestors 'none'",
	interactive:
		"sandbox allow-scripts allow-downloads; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'none'",
};

export function shareCsp(kind, { token, draftEnabled, origin } = {}) {
	const base = SHARE_CSP[kind];

	if (
		kind !== "interactive" ||
		!draftEnabled ||
		!TOKEN_RE.test(token || "") ||
		!ORIGIN_RE.test(origin || "")
	) {
		return base;
	}

	return `${base}; connect-src ${origin}/s/${token}/draft`;
}

const HEADERS = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET, PUT, OPTIONS",
	"access-control-allow-headers": "content-type",
	"access-control-max-age": "600",
	"cache-control": "no-store",
	"x-robots-tag": "noindex, nofollow",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
};

const json = (status, body) => ({
	status,
	headers: { ...HEADERS, "content-type": "application/json" },
	body: JSON.stringify(body),
});

// Read at most `max` bytes of the body; null when it is larger, whatever Content-Length claims.
async function readCapped(request, max) {
	const declared = Number(request.headers.get("content-length"));

	if (Number.isFinite(declared) && declared > max) {
		return null;
	}

	if (!request.body) {
		return "";
	}

	const reader = request.body.getReader();
	const chunks = [];
	let total = 0;

	for (;;) {
		const { done, value } = await reader.read();

		if (done) {
			break;
		}

		total += value.byteLength;

		if (total > max) {
			await reader.cancel().catch(() => {});

			return null;
		}

		chunks.push(Buffer.from(value));
	}

	return Buffer.concat(chunks).toString("utf8");
}

// Parse and normalise a draft: { paras: string[1..10], checks?: { "1".."9": boolean } }.
// Returns the canonical object, or null when anything is off.
function parseDraft(text) {
	let draft;

	try {
		draft = JSON.parse(text);
	} catch {
		return null;
	}

	if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
		return null;
	}

	if (Object.keys(draft).some((k) => k !== "paras" && k !== "checks")) {
		return null;
	}

	const { paras, checks = {} } = draft;

	if (!Array.isArray(paras) || paras.length < 1 || paras.length > MAX_PARAS) {
		return null;
	}

	if (!paras.every((p) => typeof p === "string" && p.length <= MAX_PARA_CHARS)) {
		return null;
	}

	if (!checks || typeof checks !== "object" || Array.isArray(checks)) {
		return null;
	}

	const entries = Object.entries(checks);

	if (!entries.every(([k, v]) => /^[1-9]$/.test(k) && typeof v === "boolean")) {
		return null;
	}

	return { paras, checks: Object.fromEntries(entries) };
}

// The whole endpoint. `request` is a WHATWG Request; `ip` is the client address the route derived.
export async function handleShareDraft({ request, token, ip, now = Date.now() }) {
	const { method } = request;

	if (method === "OPTIONS") {
		return { status: 204, headers: { ...HEADERS }, body: null };
	}

	if (method !== "GET" && method !== "PUT") {
		return { status: 405, headers: { ...HEADERS, allow: "GET, PUT, OPTIONS" }, body: null };
	}

	if (!take(`share-draft-ip:${ip || "unknown"}`, { ...IP_LIMIT, now }).ok) {
		return json(429, { error: "slow down" });
	}

	let text = "";

	if (method === "PUT") {
		text = await readCapped(request, BODY_MAX);

		if (text === null) {
			return json(413, { error: "too large" });
		}
	}

	const resolved = TOKEN_RE.test(token || "") ? resolveShare(token) : undefined;

	if (!resolved || !resolved.share.draft_enabled || resolved.artifact.kind !== "interactive") {
		return json(404, { error: "not found" });
	}

	if (!take(`share-draft:${resolved.share.id}`, { ...SHARE_LIMIT, now }).ok) {
		return json(429, { error: "slow down" });
	}

	if (method === "GET") {
		const latest = getLatestShareDraft(resolved.share.id);

		return json(
			200,
			latest
				? { draft: JSON.parse(latest.content), rev: latest.id, updated_at: latest.created_at }
				: { draft: null },
		);
	}

	const draft = parseDraft(text);

	if (!draft) {
		return json(400, { error: "bad draft" });
	}

	const saved = saveShareDraft(resolved.share.id, JSON.stringify(draft));

	return json(200, { ok: true, rev: saved.id, updated_at: saved.created_at });
}
