#!/usr/bin/env node
// tracker-mcp — MCP server exposing the local tracker as tools.
//
// Tools: get_ready, up_next, claim, reap, file, update, close.
// Transport: stdio (one server per Claude Code session, launched by the client).
// DB: TASKS_DB_PATH or the generic db.js default.
//
// IMPORTANT (task-344): every WRITE tool routes through the canonical mutation
// helpers in ../src/lib/server/db.js — the SAME single source of truth the web UI
// uses (file->createTask, update/close->updateTask, claim->claimNext, reap->reapLeases).
// The previous implementation ran RAW `UPDATE/INSERT` statements that bypassed the
// tracker invariants the SvelteKit path enforces:
//   • blocked-guard      — `updateTask` rejects status='blocked' with no live blocker
//   • cascade-unblock    — closing/dropping a task frees its dependents (blocked->todo)
//   • events-log write   — every mutation logs a (capped, rolling-window) event
// Read tools (get_ready, up_next) keep their own SELECTs — no invariants to enforce on
// reads, and they resolve a project FILTER without creating it. All tools share the SAME
// better-sqlite3 file handle exported as `db`, so there is exactly one connection.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// db.js resolves TASKS_DB_PATH at import time, falling back to its generic local default.

const DB = await import("../src/lib/server/db.js");
const db = DB.default; // the shared connection (used only for read queries below)
const {
	createTask,
	updateTask,
	getTask,
	getProjectByName,
	ensureProject,
	defaultProjectId,
	claimNext,
	reapLeases,
	closeTask,
	archiveProject,
	unarchiveProject,
	listArchivedProjects,
} = DB;

// archived-project exclusion (mirrors db.js NOTARCHIVED) — get_ready/up_next build raw queries here.
const NOTARCHIVED =
	"AND (project_id IS NULL OR project_id NOT IN (SELECT id FROM projects WHERE archived_at IS NOT NULL))";

// ── helpers ──────────────────────────────────────────────────────────────────
const projName = (id) =>
	id ? db.prepare("SELECT name FROM projects WHERE id=?").get(id)?.name || null : null;
// Resolve a project NAME to an id, AUTO-CREATING on first reference — for WRITE paths
// only (file / update-reassign), mirroring the canonical web `ensureProject` behavior.
const projIdForWrite = (name) => (name ? ensureProject(name) : null);
// Resolve a project NAME for a read FILTER without creating it. An unknown project
// name yields a sentinel id (-1) that matches nothing, so a typo in a filter returns
// an empty set instead of silently minting a phantom project (agent-c review, task-344).
const projIdForFilter = (name) => {
	if (!name) return null;

	return getProjectByName(name)?.id ?? -1;
};

const shape = (t) =>
	t && {
		id: t.id,
		title: t.title,
		kind: t.kind,
		status: t.status,
		priority: t.priority,
		up_next: !!t.up_next,
		rank: t.rank,
		project: projName(t.project_id),
		body: t.body || undefined,
		parent_id: t.parent_id || undefined,
		assignee: t.assignee || undefined,
		blocked_on: t.blocked_on || undefined,
		result_summary: t.result_summary || undefined,
	};
const ACTIVE = "status NOT IN ('done','dropped')";
const txt = (obj) => ({
	content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
});

// ── server ───────────────────────────────────────────────────────────────────
const server = new McpServer({ name: "tracker", version: "0.2.0" });

// get_ready — what's actionable right now (Up Next + In Progress + open questions)
server.tool(
	"get_ready",
	"List the actionable items in the tracker right now: Up Next tasks (top of the queue), In Progress tasks, and any open questions. Optionally filter to a single project and/or a single assignee.",
	{
		project: z.string().optional().describe("Filter to a single project by name"),
		assignee: z.string().optional().describe("Filter to a single assignee (agent/human) by name"),
	},
	async ({ project, assignee }) => {
		const pid = project ? projIdForFilter(project) : null;
		const pf = pid ? " AND project_id=@pid" : "";
		const af = assignee ? " AND assignee=@asg" : "";
		const a = { ...(pid ? { pid } : {}), ...(assignee ? { asg: assignee } : {}) };
		const upNext = db
			.prepare(
				`SELECT * FROM tasks WHERE up_next=1 AND kind IN ('task','idea') AND ${ACTIVE} AND status != 'blocked'${pf}${af} ${NOTARCHIVED} ORDER BY rank, priority`,
			)
			.all(a);
		const doing = db
			.prepare(`SELECT * FROM tasks WHERE status='doing'${pf}${af} ${NOTARCHIVED}`)
			.all(a);
		const questions = db
			.prepare(
				`SELECT * FROM tasks WHERE kind='question' AND (answer='' OR answer IS NULL) AND ${ACTIVE}${pf}${af} ${NOTARCHIVED} ORDER BY priority`,
			)
			.all(a);

		return txt({
			up_next: upNext.map(shape),
			in_progress: doing.map(shape),
			open_questions: questions.map((t) => ({
				id: t.id,
				title: t.title,
				options: t.options || null,
			})),
		});
	},
);

// up_next — single next task to work on (rank+priority sorted)
server.tool(
	"up_next",
	"Get THE single next task to work on from Up Next (top of rank+priority). Returns null if nothing is queued. Optionally filter by project, required capability, and/or assignee.",
	{
		project: z.string().optional().describe("Filter to a single project by name"),
		capability: z.string().optional().describe("Only return tasks tagged with this capability"),
		assignee: z.string().optional().describe("Only return tasks assigned to this agent/human"),
	},
	async ({ project, capability, assignee }) => {
		const where = [
			"up_next=1",
			ACTIVE,
			"status != 'blocked'",
			"kind IN ('task','idea')",
			"(project_id IS NULL OR project_id NOT IN (SELECT id FROM projects WHERE archived_at IS NOT NULL))",
		];
		const params = {};

		if (project) {
			where.push("project_id=@pid");
			params.pid = projIdForFilter(project);
		}

		if (capability) {
			where.push("capability=@cap");
			params.cap = capability;
		}

		if (assignee) {
			where.push("assignee=@asg");
			params.asg = assignee;
		}

		const t = db
			.prepare(`SELECT * FROM tasks WHERE ${where.join(" AND ")} ORDER BY rank, priority LIMIT 1`)
			.get(params);

		return txt(t ? shape(t) : "null");
	},
);

// claim — atomically grab THE next Up Next task (lockless CAS) via canonical claimNext().
// Distinct from the canonical claimTask() which is scoped to a pre-assigned worker; this is
// a deliberately lockless, assignee-agnostic grab. The guarded single-statement UPDATE inside
// claimNext is the atomicity invariant (no double-claim), and it logs a 'claim' audit event —
// so this write goes through the same source of truth as every other mutation (task-344).
server.tool(
	"claim",
	"Atomically claim the next available Up Next task (lockless compare-and-set). Returns {claimed, token} or null if nothing is free / you lost the race. Use this instead of up_next+update so two sessions can't grab the same task.",
	{
		worker: z.string().describe("Who is claiming (agent/session name)"),
		project: z.string().optional().describe("Only claim from this project"),
		capability: z.string().optional().describe("Only claim tasks tagged with this capability"),
		assignee: z.string().optional().describe("Only claim tasks assigned to this name"),
	},
	async ({ worker, project, capability, assignee }) => {
		const r = claimNext(worker, {
			project_id: project ? projIdForFilter(project) : null,
			capability: capability || null,
			assignee: assignee || null,
		});

		return txt(r ? { claimed: shape(r), token: r.claim_token } : "null");
	},
);

// reap — crash recovery: flip stale 'doing' leases back to 'todo'. Returns count reaped.
server.tool(
	"reap",
	"Reclaim tasks stuck in 'doing' past their lease (crashed/killed workers) by flipping them back to 'todo'. Returns how many were reaped. Safe to run anytime.",
	{},
	async () => {
		// canonical: clears the lease secrets too and uses the same predicate as the web path.
		return txt({ reaped: reapLeases() });
	},
);

// file — create a new task (idea/task/question) via the canonical createTask (logs a 'create' event).
server.tool(
	"file",
	"File a new task, idea, or question into the tracker. Returns the created row. Default kind is 'idea' which lands in the inbox; kind='task' goes straight to status='todo'.",
	{
		title: z.string().min(1).describe("Required. Short title."),
		kind: z.enum(["task", "idea", "question"]).default("idea"),
		project: z.string().optional().describe("Project name (auto-created if new)"),
		priority: z.number().int().min(0).max(3).default(2).describe("0=P0 highest .. 3=P3"),
		body: z.string().default("").describe("Longer description / context"),
		parent_id: z.number().int().optional().describe("Parent task id (sub-task)"),
		up_next: z.boolean().default(false).describe("Mark as Up Next"),
		discovered_from: z
			.number()
			.int()
			.optional()
			.describe(
				"Task id this was discovered from (records a non-blocking 'discovered_from' provenance link)",
			),
		owner_machine: z.string().optional().describe("Routing hint: which host should run it"),
		suggested_agent: z.string().optional().describe("Routing hint: recommended worker persona"),
		effort: z.string().optional().describe("Routing hint: rough size (e.g. xs|s|m|l)"),
		parallel_group: z
			.string()
			.optional()
			.describe("Routing hint: tasks sharing a group may run concurrently"),
	},
	async ({
		title,
		kind,
		project,
		priority,
		body,
		parent_id,
		up_next,
		discovered_from,
		owner_machine,
		suggested_agent,
		effort,
		parallel_group,
	}) => {
		// task-192: never file a floating task — explicit project wins, else inherit the
		// parent's project, else fall back to the default catch-all (rather than null).
		const project_id = project
			? projIdForWrite(project)
			: ((parent_id ? (getTask(parent_id)?.project_id ?? null) : null) ?? defaultProjectId());
		const id = createTask({
			title,
			kind,
			project_id,
			priority,
			body,
			parent_id: parent_id ?? null,
			up_next: up_next ? 1 : 0,
			status: kind === "idea" ? "inbox" : "todo",
			created_by: "mcp",
			discovered_from: discovered_from ?? null,
			owner_machine,
			suggested_agent,
			effort,
			parallel_group,
		});

		return txt({ filed: shape(getTask(id)) });
	},
);

// update — patch fields on an existing task via the canonical updateTask.
// Enforces blocked-guard, lease release on exit-doing, event logging, and
// cascade-unblock (when status -> done/dropped). The guard result is surfaced
// so a rejected transition (e.g. status='blocked' with no live blocker) is visible.
server.tool(
	"update",
	"Update one or more fields on an existing task. Supply the task id plus any fields to change. Returns the updated row. Enforces tracker invariants (blocked-guard, cascade-unblock, audit log).",
	{
		id: z.number().int(),
		status: z.enum(["inbox", "todo", "doing", "blocked", "review", "done", "dropped"]).optional(),
		priority: z.number().int().min(0).max(3).optional(),
		up_next: z.boolean().optional(),
		title: z.string().optional(),
		body: z.string().optional(),
		project: z.string().optional().describe("Reassign to a different project"),
		blocked_on: z.string().optional(),
		assignee: z.string().optional(),
		result_summary: z.string().optional(),
		owner_machine: z.string().optional().describe("Routing hint: which host should run it"),
		suggested_agent: z.string().optional().describe("Routing hint: recommended worker persona"),
		effort: z.string().optional().describe("Routing hint: rough size (e.g. xs|s|m|l)"),
		parallel_group: z
			.string()
			.optional()
			.describe("Routing hint: tasks sharing a group may run concurrently"),
	},
	async ({ id, project, ...patch }) => {
		if (!getTask(id)) return txt(`task #${id} not found`);

		const clean = {};

		for (const [k, v] of Object.entries(patch)) {
			if (v === undefined) continue;

			clean[k] = typeof v === "boolean" ? (v ? 1 : 0) : v;
		}

		if (project !== undefined) clean.project_id = project ? projIdForWrite(project) : null;

		if (!Object.keys(clean).length) return txt("(no fields to update)");

		const res = updateTask(id, clean);

		// updateTask returns {ok:false,reason,message} when an invariant blocks the change
		// (e.g. status='blocked' with no live blocker). Surface it instead of lying "updated".
		if (res?.ok === false) return txt({ rejected: res });

		return txt({ updated: shape(getTask(id)) });
	},
);

// close — mark a task done via the canonical closeTask (REQUIRES a reason — the "why" ledger).
// closeTask stores close_reason, emits a tiny 'closed' event, and routes the status change
// through updateTask (so cascade-unblock + audit log still fire). A missing/blank reason is
// rejected with {rejected:{reason:'reason_required'}} instead of silently closing.
server.tool(
	"close",
	"Mark a task done (or dropped) WITH A MANDATORY one-line reason — the 'why' ledger. Optionally record a result summary. Rejects a close with no reason.",
	{
		id: z.number().int(),
		reason: z.string().min(1).describe("Required. Why it's being closed (the why-ledger)."),
		status: z.enum(["done", "dropped"]).default("done").describe("done (default) or dropped"),
		result_summary: z.string().optional().describe("One-line note about the outcome"),
	},
	async ({ id, reason, status, result_summary }) => {
		if (!getTask(id)) return txt(`task #${id} not found`);

		if (result_summary !== undefined) updateTask(id, { result_summary });

		const res = closeTask(id, { reason, by: "mcp", status });

		if (res?.ok === false) return txt({ rejected: res });

		return txt({ closed: shape(getTask(id)) });
	},
);

server.tool(
	"archive_project",
	"Archive a whole project by name: its tasks vanish from all active views (board/up-next/counts) but are NOT deleted — fully restorable. Use to close out a project.",
	{ name: z.string().min(1).describe("Project name to archive") },
	async ({ name }) => {
		const r = archiveProject(name);

		return txt(
			r.changes
				? { archived: name }
				: { error: `no active project named '${name}' (already archived or doesn't exist)` },
		);
	},
);

server.tool(
	"unarchive_project",
	"Restore a previously archived project: its tasks reappear in active views. Pass the project name.",
	{ name: z.string().min(1).describe("Project name to restore") },
	async ({ name }) => {
		const r = unarchiveProject(name);

		return txt(r.changes ? { restored: name } : { error: `no project named '${name}'` });
	},
);

// ── boot ─────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();

await server.connect(transport);
