// agent-API core — the single RPC handler behind POST /api/agent/rpc.
//
// A remote headless agent reaches the gallery over HTTPS with a bearer token minted by
// scripts/mint-agent-token.mjs — no Authentik session. The route is SSO-exempt
// (hooks.server.js isAgentApi), so EVERYTHING rests on two properties enforced here:
//
//   1. FAIL-CLOSED AUTH — no valid `Authorization: Bearer <token>` → 401 with a generic
//      body. verifyAgentToken (db.js) matches sha256(token) against unrevoked rows only.
//   2. SCOPE CONFINEMENT — a scoped token (assignee or project set) is refused every op with
//      the same generic 404 an unknown target gets. Only an UNSCOPED token reaches the ops below.
//
// Framework-free on purpose: handleAgentRpc takes plain values and returns { status, body },
// so scripts/test-agent-api.mjs exercises the REAL handler under plain node; the +server.js
// route is a thin wrapper.
import {
	verifyAgentToken,
	getArtifact,
	getFeedback,
	listFeedback,
	listMarkup,
	resolveFeedback,
} from "./db.js";
import { getHome, setHome, HOME_MAX } from "./home.js";

const bad = (error) => ({ status: 400, body: { error } });
const notFound = () => ({ status: 404, body: { error: "not_found" } }); // generic — never reveals existence

export const BODY_MAX = 32 * 1024; // request-body cap — RPC args are small; anything bigger is abuse

const OPS = new Set(["get_markup", "set_home", "get_home", "list_feedback", "resolve_feedback"]);

// ── rate limit: in-memory token bucket per agent_name (60 req/min) ───────────
// Process-local is fine — better-sqlite3 pins this app to a single process. A restart
// refills buckets; acceptable for an abuse brake (auth is the security boundary, not this).
const RATE_LIMIT = 60; // requests
const RATE_WINDOW_MS = 60_000; // per minute
const buckets = new Map();

function rateLimited(name, now = Date.now()) {
	let b = buckets.get(name);

	if (!b) {
		b = { tokens: RATE_LIMIT, at: now };
		buckets.set(name, b);
	}

	b.tokens = Math.min(RATE_LIMIT, b.tokens + ((now - b.at) * RATE_LIMIT) / RATE_WINDOW_MS);
	b.at = now;

	if (b.tokens < 1) {
		return true;
	}

	b.tokens -= 1;

	return false;
}

export const resetRateLimiter = () => buckets.clear(); // test hook only

// Feedback lives on an artifact, and an artifact belongs to a project (its collection). A token
// scoped to projects may touch feedback only on pages in those projects; an assignee-scoped token
// has no lane in the gallery. Anything else is the same generic 404 as an unknown id.
const inLane = (scope, artifact) =>
	Boolean(artifact) &&
	scope.assignee == null &&
	(scope.projects == null || scope.projects.includes(artifact.collection));

// ── op handlers (auth + scope already resolved) ──────────────────────────────
const ops = {
	// pencil ink on a gallery artifact, every author's or one author's, plus the page itself
	// when args.content is true (scripts/render-markup.mjs draws the two together). Artifacts
	// sit outside the assignee/project lane model, so only an UNSCOPED token may read them; a
	// scoped token gets the same generic 404 as an unknown slug.
	get_markup(scope, args) {
		if (scope.assignee != null || scope.projects != null) {
			return notFound();
		}

		if (typeof args.slug !== "string") {
			return bad("bad_request");
		}

		const a = getArtifact(args.slug, null);

		if (!a) {
			return notFound();
		}

		const markups = listMarkup(a.slug).filter(
			(m) => args.author == null || m.author === args.author,
		);

		return {
			status: 200,
			body: {
				slug: a.slug,
				title: a.title,
				kind: a.kind,
				markups,
				...(args.content === true ? { content: String(a.content) } : {}),
			},
		};
	},

	// Feedback on one page (every viewer's), optionally only the items still waiting on Janet.
	list_feedback(scope, args) {
		if (typeof args.slug !== "string") {
			return bad("bad_request");
		}

		const a = getArtifact(args.slug, null);

		if (!inLane(scope, a)) {
			return notFound();
		}

		const status = args.status === undefined ? undefined : String(args.status);

		return {
			status: 200,
			body: { slug: a.slug, rev: a.rev, feedback: listFeedback(a.slug, { status }) },
		};
	},

	// Janet closes an item after answering it. Resolving does not publish: she revises the page
	// first (a new rev) and resolves against it, so resolved_rev defaults to the current rev.
	resolve_feedback(scope, args) {
		if (!Number.isInteger(args.id) || typeof args.resolution !== "string") {
			return bad("bad_request");
		}

		const item = getFeedback(args.id);

		if (!item || !inLane(scope, getArtifact(item.slug, null))) {
			return notFound();
		}

		return { status: 200, body: { resolved: resolveFeedback(args) } };
	},

	// Janet's home page (/janet/home). One document, replaced whole. It sits outside the
	// assignee/project lane model, so only an UNSCOPED token may touch it (scoped = generic 404).
	set_home(scope, args) {
		if (scope.assignee != null || scope.projects != null) {
			return notFound();
		}

		if (typeof args.markdown !== "string" || args.markdown.length > HOME_MAX) {
			return bad("bad_request");
		}

		const { updated_at } = setHome(args.markdown);

		return { status: 200, body: { updated_at } };
	},

	get_home(scope) {
		if (scope.assignee != null || scope.projects != null) {
			return notFound();
		}

		return { status: 200, body: getHome() };
	},
};

// ── the handler ──────────────────────────────────────────────────────────────
// handleAgentRpc({ authorization, rawBody }) → { status, body }.
// Order is deliberate: auth (401) → rate limit (429) → body/op validation (400/413)
// → scope-confined dispatch. Every failure body is generic; the token never appears
// in any response or log line.
// Ops that only READ. A read-only token may call these and nothing else. Listed
// explicitly rather than derived by negation: adding a new write op must not
// accidentally become callable by every read-only token that already exists.
const READ_OPS = new Set(["get_markup", "get_home", "list_feedback"]);

export function handleAgentRpc({ authorization, rawBody } = {}) {
	const m = /^Bearer\s+(\S+)$/i.exec(String(authorization ?? "").trim());
	const tok = m ? verifyAgentToken(m[1]) : null;

	if (!tok) {
		return { status: 401, body: { error: "unauthorized" } };
	}

	if (rateLimited(tok.agent_name)) {
		console.log(`[agent-api] ${tok.agent_name} rate-limited -> 429`);

		return { status: 429, body: { error: "rate_limited" } };
	}

	if (typeof rawBody !== "string" || rawBody.length > BODY_MAX) {
		return { status: 413, body: { error: "body_too_large" } };
	}

	let parsed;

	try {
		parsed = JSON.parse(rawBody);
	} catch {
		return { status: 400, body: { error: "bad_json" } };
	}

	const op = parsed?.op;
	const args =
		parsed?.args && typeof parsed.args === "object" && !Array.isArray(parsed.args)
			? parsed.args
			: {};

	if (typeof op !== "string" || !OPS.has(op)) {
		console.log(
			`[agent-api] ${tok.agent_name} (unknown-op len=${typeof op === "string" ? op.length : 0}) -> err unknown_op`,
		);

		return { status: 400, body: { error: "unknown_op" } };
	}

	// A read-only token is refused at DISPATCH, before any handler runs. 403 rather than
	// the scope-confinement 404: the op exists and the caller is known, they simply may not
	// call it, and pretending otherwise would make a misconfigured token look like an empty
	// tracker - the exact confusion this API is built to avoid.
	if (tok.scope_readonly && !READ_OPS.has(op)) {
		console.log(`[agent-api] ${tok.agent_name} ${op} -> err read_only_token`);

		return { status: 403, body: { error: "read_only_token" } };
	}

	const scope = { assignee: tok.scope_assignee, projects: tok.scope_projects };
	let res;

	try {
		res = ops[op](scope, args, tok);
	} catch (e) {
		// never leak internals to the caller; log server-side (message only, no token, no body).
		console.log(`[agent-api] ${tok.agent_name} ${op} -> err ${e?.message || e}`);

		return { status: 400, body: { error: "bad_request" } };
	}

	console.log(
		`[agent-api] ${tok.agent_name} ${op} -> ${res.status < 400 ? "ok" : `err ${res.body?.error || res.status}`}`,
	);

	return res;
}
