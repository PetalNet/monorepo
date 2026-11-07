// agent-API core — the single RPC handler behind POST /api/agent/rpc.
//
// A remote headless agent (an agent) reaches the tracker over HTTPS with a bearer token
// minted by scripts/mint-agent-token.mjs — no Authentik session. The route is SSO-exempt
// (hooks.server.js isAgentApi), so EVERYTHING rests on two properties enforced here:
//
//   1. FAIL-CLOSED AUTH — no valid `Authorization: Bearer <token>` → 401 with a generic
//      body. verifyAgentToken (db.js) matches sha256(token) against unrevoked rows only.
//   2. SCOPE CONFINEMENT — the tracker holds sensitive P0 findings, so a scoped token is
//      confined to its lane. A task is IN SCOPE iff
//        (scope.assignee == null || task.assignee === scope.assignee) AND
//        (scope.projects == null || projectName(task) ∈ scope.projects).
//      Reads push the scope into the SQL filters AND post-filter the rows (belt+braces);
//      get/update/close on an out-of-scope id return a generic 404 that never reveals the
//      task exists; claim constrains claimNext so it can never grab out-of-scope work;
//      file forces the new task INTO scope; reap only touches this agent's own leases;
//      blocker edges (add/remove_blocker) need BOTH ends in scope, list_blockers drops
//      out-of-scope neighbours.
//
// ALL writes route through the canonical db.js helpers (createTask / updateTask /
// closeTask / claimNext / reapLeases / addBlocker / removeBlocker) exactly like mcp/tracker-mcp.mjs — NEVER raw
// INSERT/UPDATE on tasks — preserving blocked-guard, cascade-unblock and the audit log
// (task-344). Read SELECT statements mirror the MCP server's (no invariants on reads).
//
// Framework-free on purpose: handleAgentRpc takes plain values and returns
// { status, body }, so scripts/test-agent-api.mjs exercises the REAL handler under
// plain node; the +server.js route is a thin wrapper.
import db, {
	createTask,
	updateTask,
	getTask,
	getProjectByName,
	ensureProject,
	defaultProjectId,
	claimNext,
	reapLeases,
	closeTask,
	verifyAgentToken,
	addBlocker,
	removeBlocker,
	blockersOf,
	blocks,
	unfinishedBlockers,
} from "./db.js";

// mirrors mcp/tracker-mcp.mjs — archived-project exclusion + active predicate + shape()
const NOTARCHIVED =
	"AND (project_id IS NULL OR project_id NOT IN (SELECT id FROM projects WHERE archived_at IS NOT NULL))";
const ACTIVE = "status NOT IN ('done','dropped')";
// No live blocker edge. A blocker only flips a 'todo' task to 'blocked' (add_blocker), so an
// up_next task in another status (review, inbox) would otherwise stay "ready" while blocked.
const UNBLOCKED =
	"NOT EXISTS (SELECT 1 FROM task_blockers tb JOIN tasks bt ON bt.id=tb.blocker_id WHERE tb.task_id=tasks.id AND bt.status NOT IN ('done','dropped'))";
const projName = (id) =>
	id ? db.prepare("SELECT name FROM projects WHERE id=?").get(id)?.name || null : null;
const shape = (t, scope) =>
	t && {
		id: t.id,
		title: t.title,
		kind: t.kind,
		type: t.type || undefined,
		status: t.status,
		priority: t.priority,
		up_next: Boolean(t.up_next),
		rank: t.rank,
		project: projName(t.project_id),
		body: t.body || undefined,
		// parent_id is WITHHELD unless the parent is itself in the caller's scope — otherwise a
		// legit in-scope child leaks the existence + id of an out-of-scope parent (adversarial
		// review F1). No scope passed (unscoped token) → always include.
		parent_id:
			t.parent_id && (!scope || inScope(getTask(t.parent_id), scope)) ? t.parent_id : undefined,
		assignee: t.assignee || undefined,
		blocked_on: t.blocked_on || undefined,
		result_summary: t.result_summary || undefined,
	};

export const BODY_MAX = 32 * 1024; // request-body cap — RPC args are small; anything bigger is abuse
const OPS = new Set([
	"get_ready",
	"up_next",
	"get",
	"claim",
	"update",
	"close",
	"file",
	"reap",
	"add_blocker",
	"remove_blocker",
	"list_blockers",
	"set_type",
]);

// task.type vocabulary (free TEXT column, default 'task'). Allowlisted so a typo'd type can't
// silently fall out of every type-keyed view: the wayfinder set + the values already in use.
export const TASK_TYPES = new Set([
	"task",
	"build",
	"wayfinder-map",
	"grilling",
	"research",
	"prototype",
]);

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

// ── scope machinery ──────────────────────────────────────────────────────────
// Resolve the token's project-name scope to EXISTING project ids (a read filter must
// never create a project — projIdForFilter rule, task-344). Unknown names drop out; a
// project scope that resolves to nothing matches nothing (fail closed, not open).
const scopeProjectIds = (scope) =>
	scope.projects
		? scope.projects.map((n) => getProjectByName(n)?.id).filter((id) => id != null)
		: null;

// THE scope predicate. A task with NO project counts as OUT of a project-scoped lane.
function inScope(t, scope) {
	if (!t) {
		return false;
	}

	if (scope.assignee != null && (t.assignee || "") !== scope.assignee) {
		return false;
	}

	if (scope.projects != null) {
		const name = projName(t.project_id);

		if (!name || !scope.projects.includes(name)) {
			return false;
		}
	}

	return true;
}

// Effective read filters = token scope ∩ caller args. Caller args may only NARROW the
// scope, never widen it; a contradiction (args outside the scope) yields the EMPTY set
// rather than an error, so probing filters can't distinguish "excluded" from "empty".
function effectiveAssignee(scope, args) {
	const want = args.assignee == null ? null : String(args.assignee);

	if (scope.assignee != null) {
		if (want != null && want !== scope.assignee) {
			return { empty: true };
		}

		return { value: scope.assignee };
	}

	return { value: want };
}

function effectiveProjectIds(scope, args) {
	const want = args.project == null ? null : String(args.project);

	if (want != null) {
		if (scope.projects != null && !scope.projects.includes(want)) {
			return { empty: true };
		}

		// unknown name → sentinel -1: matches nothing instead of minting a phantom project
		return { ids: [getProjectByName(want)?.id ?? -1] };
	}

	const ids = scopeProjectIds(scope);

	if (ids?.length === 0) {
		return { empty: true };
	}

	return { ids }; // null = unrestricted
}

// SQL fragment + params for the effective filters, or { empty:true }.
function readScope(scope, args) {
	const asg = effectiveAssignee(scope, args);

	if (asg.empty) {
		return { empty: true };
	}

	const proj = effectiveProjectIds(scope, args);

	if (proj.empty) {
		return { empty: true };
	}

	const where = [];
	const params = {};

	if (asg.value != null) {
		where.push("AND assignee=@asg");
		params.asg = asg.value;
	}

	if (proj.ids != null) {
		const ph = proj.ids.map((id, i) => {
			params[`p${i}`] = id;

			return `@p${i}`;
		});

		where.push(`AND project_id IN (${ph.join(",")})`);
	}

	return { where: where.join(" "), params, empty: false };
}

// ── per-op arg validation ────────────────────────────────────────────────────
const isInt = (v) => Number.isInteger(v);
// `update` may only set NON-TERMINAL, NON-'doing' statuses: 'done'/'dropped' MUST route
// through `close` (mandatory why-ledger reason + 'closed' event) and 'doing' through
// `claim` (atomic lease + claim token + 'claim' audit). Otherwise a bearer agent bypasses
// those invariants on its own in-scope task (agent-c review). todo/inbox/blocked/review are
// safe direct transitions (blocked still hits updateTask's blocked-guard).
const UPDATE_STATUSES = new Set(["inbox", "todo", "blocked", "review"]);
// update: EXPLICIT allowlist mirroring the MCP update tool. Never pass caller keys
// straight to updateTask — its PATCHABLE set includes server-only columns
// (claim_token, owner, visibility, kind, parent_id) a bearer agent must not touch.
const UPDATE_FIELDS = new Set([
	"status",
	"priority",
	"up_next",
	"title",
	"body",
	"project",
	"blocked_on",
	"assignee",
	"result_summary",
	"owner_machine",
	"suggested_agent",
	"effort",
	"parallel_group",
]);

const bad = (error) => ({ status: 400, body: { error } });
// minimal {id,title,status} for edge listings — never bodies
const edge = (t) => ({ id: t.id, title: t.title, status: t.status });

// Would the edge "task_id is blocked BY blocker_id" close a cycle? True iff task_id already
// (transitively) blocks blocker_id, i.e. task_id is reachable walking blocker_id's blockers.
// Walks the WHOLE graph (not scope-filtered) — a cycle through an out-of-scope task is still
// a deadlock. The rejection names no ids, so it discloses only that some path exists.
function wouldCycle(task_id, blocker_id) {
	const next = db.prepare("SELECT blocker_id FROM task_blockers WHERE task_id=?");
	const seen = new Set([blocker_id]);
	const stack = [blocker_id];
	while (stack.length) {
		const cur = stack.pop();
		for (const { blocker_id: b } of next.all(cur)) {
			if (b === task_id) return true;
			if (!seen.has(b)) {
				seen.add(b);
				stack.push(b);
			}
		}
	}
	return false;
}
// Both ends of a blocking edge must be in scope: the task (404 if not, like get/update) and
// the blocker (same 'invalid_blocker' for out-of-scope and nonexistent — no existence oracle).
function edgeEnds(scope, args) {
	if (!isInt(args.id) || !isInt(args.blocked_by)) return { err: bad("bad_request") };
	const t = getTask(args.id);
	if (!inScope(t, scope)) return { err: notFound() };
	if (args.blocked_by === args.id) return { err: bad("self_block") };
	const b = getTask(args.blocked_by);
	if (!inScope(b, scope)) return { err: bad("invalid_blocker") };
	return { t, b };
}
const notFound = () => ({ status: 404, body: { error: "not_found" } }); // generic — never reveals existence

// ── op handlers (auth + scope already resolved) ──────────────────────────────
const ops = {
	// actionable-now listing, mirroring MCP get_ready — scope pushed into SQL AND post-filtered.
	get_ready(scope, args) {
		const f = readScope(scope, args);

		if (f.empty) {
			return { status: 200, body: { up_next: [], in_progress: [], open_questions: [] } };
		}

		const upNext = db
			.prepare(
				`SELECT * FROM tasks WHERE up_next=1 AND kind IN ('task','idea') AND ${ACTIVE} AND status != 'blocked' AND ${UNBLOCKED} ${f.where} ${NOTARCHIVED} ORDER BY rank, priority`,
			)
			.all(f.params);
		const doing = db
			.prepare(`SELECT * FROM tasks WHERE status='doing' ${f.where} ${NOTARCHIVED}`)
			.all(f.params);
		const questions = db
			.prepare(
				`SELECT * FROM tasks WHERE kind='question' AND (answer='' OR answer IS NULL) AND ${ACTIVE} ${f.where} ${NOTARCHIVED} ORDER BY priority`,
			)
			.all(f.params);
		const mine = (rows) => rows.filter((t) => inScope(t, scope)); // belt+braces post-filter

		return {
			status: 200,
			body: {
				up_next: mine(upNext).map((x) => shape(x, scope)),
				in_progress: mine(doing).map((x) => shape(x, scope)),
				open_questions: mine(questions).map((t) => ({
					id: t.id,
					title: t.title,
					options: t.options || null,
				})),
			},
		};
	},

	// THE single next task (rank+priority), scope-constrained.
	up_next(scope, args) {
		const f = readScope(scope, args);

		if (f.empty) {
			return { status: 200, body: { task: null } };
		}

		const params = { ...f.params };
		let capf = "";

		if (args.capability != null) {
			capf = " AND capability=@cap";
			params.cap = String(args.capability);
		}

		const t = db
			.prepare(
				`SELECT * FROM tasks WHERE up_next=1 AND ${ACTIVE} AND status != 'blocked' AND ${UNBLOCKED} AND kind IN ('task','idea')
        ${f.where}${capf} ${NOTARCHIVED} ORDER BY rank, priority LIMIT 1`,
			)
			.get(params);

		return { status: 200, body: { task: t && inScope(t, scope) ? shape(t, scope) : null } };
	},

	// one task by id — out-of-scope and nonexistent are INDISTINGUISHABLE (generic 404).
	get(scope, args) {
		if (!isInt(args.id)) {
			return bad("bad_request");
		}

		const t = getTask(args.id);

		if (!inScope(t, scope)) {
			return notFound();
		}

		return { status: 200, body: { task: shape(t, scope) } };
	},

	// atomic claim via canonical claimNext, constrained so it can NEVER grab out-of-scope
	// work: the assignee/project filters are the token's own scope (args may only narrow).
	// A multi-project scope claims per-project in scope order (claimNext takes one
	// project_id) — each attempt is individually atomic.
	claim(scope, args, tok) {
		const worker = tok.agent_name; // PINNED to the token identity — a bearer agent can't forge claimed_by (agent-c review); args.worker is ignored
		const asg = effectiveAssignee(scope, args);

		if (asg.empty) {
			return { status: 200, body: { claimed: null } };
		}

		const proj = effectiveProjectIds(scope, args);

		if (proj.empty) {
			return { status: 200, body: { claimed: null } };
		}

		const filters = {
			capability: args.capability == null ? null : String(args.capability),
			assignee: asg.value,
		};
		const pool = proj.ids == null ? [null] : proj.ids;

		for (const project_id of pool) {
			const r = claimNext(worker, { ...filters, project_id });

			if (r) {
				if (!inScope(r, scope)) {
					// paranoid backstop — the SQL filters make this unreachable; if it ever fires,
					// release the lease rather than hand out an out-of-scope task.
					updateTask(r.id, { status: "todo" });

					return { status: 200, body: { claimed: null } };
				}

				return { status: 200, body: { claimed: shape(r, scope), token: r.claim_token } };
			}
		}

		return { status: 200, body: { claimed: null } };
	},

	// patch an in-scope task via canonical updateTask. The patch itself is confined too:
	// a scoped token may not reassign a task to another assignee/project (that would move
	// work out of — or smuggle it beyond — its lane).
	update(scope, args) {
		if (!isInt(args.id)) {
			return bad("bad_request");
		}

		const t = getTask(args.id);

		if (!inScope(t, scope)) {
			return notFound();
		}

		const clean = {};

		for (const [k, v] of Object.entries(args)) {
			if (k === "id" || v === undefined) {
				continue;
			}

			if (!UPDATE_FIELDS.has(k)) {
				return bad("bad_request");
			} // unknown field → reject, don't ignore

			clean[k] = v;
		}

		if ("status" in clean && !UPDATE_STATUSES.has(clean.status)) {
			return bad("bad_request");
		}

		if (
			"priority" in clean &&
			!(isInt(clean.priority) && clean.priority >= 0 && clean.priority <= 3)
		) {
			return bad("bad_request");
		}

		if ("up_next" in clean) {
			clean.up_next = clean.up_next ? 1 : 0;
		}

		// scope-pinning: the post-state must remain in scope.
		if (scope.assignee != null && "assignee" in clean && clean.assignee !== scope.assignee) {
			return bad("bad_request");
		}

		if ("project" in clean) {
			const name = clean.project == null ? null : String(clean.project);

			if (scope.projects != null && (name == null || !scope.projects.includes(name))) {
				return bad("bad_request");
			}

			delete clean.project;
			clean.project_id = name ? ensureProject(name) : null;
		}

		if (Object.keys(clean).length === 0) {
			return bad("bad_request");
		}

		const res = updateTask(args.id, clean);

		if (res?.ok === false) {
			return { status: 422, body: { rejected: res } };
		} // e.g. blocked-guard

		return { status: 200, body: { updated: shape(getTask(args.id), scope) } };
	},

	// close an in-scope task via canonical closeTask (mandatory reason — the why-ledger).
	close(scope, args, tok) {
		if (!isInt(args.id)) {
			return bad("bad_request");
		}

		const t = getTask(args.id);

		if (!inScope(t, scope)) {
			return notFound();
		}

		const status = args.status === "dropped" ? "dropped" : "done";

		if (args.result_summary !== undefined) {
			updateTask(args.id, { result_summary: String(args.result_summary) });
		}

		const res = closeTask(args.id, { reason: args.reason, by: `agent:${tok.agent_name}`, status });

		if (!res?.ok) {
			return { status: 422, body: { rejected: res } };
		} // e.g. reason_required

		return { status: 200, body: { closed: shape(getTask(args.id), scope) } };
	},

	// file a new task FORCED INTO scope — a scoped token can never create out-of-lane work.
	file(scope, args, tok) {
		const title = String(args.title ?? "").trim();

		if (!title) {
			return bad("bad_request");
		}

		const kind = args.kind === undefined ? "idea" : args.kind;

		if (!["task", "idea", "question"].includes(kind)) {
			return bad("bad_request");
		}

		if (args.type !== undefined && !TASK_TYPES.has(args.type)) {
			return bad("bad_type");
		}

		const priority = args.priority === undefined ? 2 : args.priority;

		if (!(isInt(priority) && priority >= 0 && priority <= 3)) {
			return bad("bad_request");
		}

		// project confinement: with a project scope, an explicit IN-SCOPE project is required
		// (no default/inherit path may land the task outside the lane) — spec §2.4.
		let project_id;

		if (scope.projects == null) {
			project_id = args.project ? ensureProject(String(args.project)) : null;
		} else {
			const name = args.project == null ? null : String(args.project);

			if (name == null || !scope.projects.includes(name)) {
				return bad("project_out_of_scope");
			}

			project_id = ensureProject(name);
		}

		// parent/provenance links may only reference IN-SCOPE tasks. Nonexistent and
		// out-of-scope ids get the SAME rejection (no existence oracle via file()).
		let parent_id = null;

		if (args.parent_id !== undefined) {
			if (!isInt(args.parent_id)) {
				return bad("bad_request");
			}

			const parent = getTask(args.parent_id);

			if (!inScope(parent, scope)) {
				return bad("invalid_parent");
			}

			parent_id = parent.id;

			if (project_id == null) {
				project_id = parent.project_id ?? null;
			} // MCP inherit rule (already in-scope)
		}

		let discovered_from = null;

		if (args.discovered_from !== undefined) {
			if (!isInt(args.discovered_from)) {
				return bad("bad_request");
			}

			if (!inScope(getTask(args.discovered_from), scope)) {
				return bad("invalid_discovered_from");
			}

			discovered_from = args.discovered_from;
		}

		if (project_id == null) {
			project_id = defaultProjectId();
		} // task-192: never floating (unscoped tokens only)

		const id = createTask({
			title,
			kind,
			project_id,
			priority,
			body: String(args.body ?? ""),
			parent_id,
			up_next: args.up_next ? 1 : 0,
			status: kind === "idea" ? "inbox" : "todo",
			created_by: `agent:${tok.agent_name}`,
			discovered_from,
			owner_machine: args.owner_machine == null ? undefined : String(args.owner_machine),
			suggested_agent: args.suggested_agent == null ? undefined : String(args.suggested_agent),
			effort: args.effort == null ? undefined : String(args.effort),
			parallel_group: args.parallel_group == null ? undefined : String(args.parallel_group),
		});
		// assignee confinement: an assignee-scoped token's tasks are ALWAYS its own.
		let assignee = scope.assignee;

		if (assignee === undefined || assignee === null) {
			assignee = String(args.assignee ?? "") || null;
		}

		if (assignee) {
			updateTask(id, { assignee });
		} // canonical helper (createTask has no assignee column)

		if (args.type !== undefined && args.type !== "task") {
			updateTask(id, { type: args.type });
		} // same (no type column in createTask)

		return { status: 201, body: { filed: shape(getTask(id), scope) } };
	},

	// crash recovery, confined: only leases THIS agent_name holds are reaped (canonical
	// reapLeases with the claimed_by filter — never the global sweep).
	reap(scope, args, tok) {
		return { status: 200, body: { reaped: reapLeases({ claimed_by: tok.agent_name }) } };
	},

	// add a blocking edge: task `id` is blocked BY `blocked_by`, via canonical addBlocker
	// ('add_blocker' event). Cycles are refused (they would deadlock both tasks forever).
	// Mirrors the web UI's blocker action: a 'todo' task with a live blocker flips to
	// 'blocked' so claim/up_next skip it. Other statuses are left alone — a 'doing' lease
	// is never yanked (call update status=blocked yourself), inbox stays un-triaged.
	// Idempotent: re-adding an existing edge is a no-op 200 with added:false.
	add_blocker(scope, args) {
		const { err, t, b } = edgeEnds(scope, args);
		if (err) return err;
		const exists = db
			.prepare("SELECT 1 FROM task_blockers WHERE task_id=? AND blocker_id=?")
			.get(t.id, b.id);
		if (!exists) {
			if (wouldCycle(t.id, b.id))
				return { status: 422, body: { rejected: { ok: false, reason: "would_cycle" } } };
			addBlocker(t.id, b.id);
		}
		if (t.status === "todo" && unfinishedBlockers(t.id).length) {
			const res = updateTask(t.id, { status: "blocked" });
			if (res && res.ok === false) return { status: 422, body: { rejected: res } };
		}
		return { status: 200, body: { added: !exists, task: shape(getTask(t.id), scope) } };
	},

	// remove a blocking edge via canonical removeBlocker ('remove_blocker' event; a 'blocked'
	// task left with no live blockers auto-returns to 'todo'). Missing edge → removed:false,
	// and no event is written.
	remove_blocker(scope, args) {
		const { err, t, b } = edgeEnds(scope, args);
		if (err) return err;
		const exists = db
			.prepare("SELECT 1 FROM task_blockers WHERE task_id=? AND blocker_id=?")
			.get(t.id, b.id);
		if (exists) removeBlocker(t.id, b.id);
		return { status: 200, body: { removed: !!exists, task: shape(getTask(t.id), scope) } };
	},

	// both directions of the blocking graph for one in-scope task. Out-of-scope neighbours are
	// dropped (same post-filter as reads), so an edge to a hidden task reveals nothing.
	list_blockers(scope, args) {
		if (!isInt(args.id)) return bad("bad_request");
		const t = getTask(args.id);
		if (!inScope(t, scope)) return notFound();
		const vis = (rows) => rows.filter((x) => inScope(x, scope)).map(edge);
		return {
			status: 200,
			body: { id: t.id, blocked_by: vis(blockersOf(t.id)), blocks: vis(blocks(t.id)) },
		};
	},

	// set task.type (allowlisted, TASK_TYPES) via canonical updateTask ('update' event).
	set_type(scope, args) {
		if (!isInt(args.id)) return bad("bad_request");
		const t = getTask(args.id);
		if (!inScope(t, scope)) return notFound();
		if (!TASK_TYPES.has(args.type)) return bad("bad_type");
		const res = updateTask(t.id, { type: args.type });
		if (res && res.ok === false) return { status: 422, body: { rejected: res } };
		return { status: 200, body: { updated: shape(getTask(t.id), scope) } };
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
const READ_OPS = new Set(["get_ready", "get"]);

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
		// canonical-helper invariants can throw (e.g. createTask's project guard) — never
		// leak internals to the caller; log server-side (message only, no token, no body).
		console.log(`[agent-api] ${tok.agent_name} ${op} -> err ${e?.message || e}`);

		return { status: 400, body: { error: "bad_request" } };
	}

	const taskId =
		res?.body?.task?.id ??
		res?.body?.updated?.id ??
		res?.body?.id ??
		res?.body?.closed?.id ??
		res?.body?.filed?.id ??
		res?.body?.claimed?.id ??
		(isInt(args.id) ? args.id : null);

	// edge ops also record the other end so the audit line captures the whole edge
	const other =
		(op === "add_blocker" || op === "remove_blocker") && isInt(args.blocked_by)
			? ` blocked_by=${args.blocked_by}`
			: "";

	console.log(
		`[agent-api] ${tok.agent_name} ${op} task=${taskId ?? "-"}${other} -> ${res.status < 400 ? "ok" : `err ${res.body?.error || res.status}`}`,
	);

	return res;
}
