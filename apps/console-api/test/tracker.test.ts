import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { readTasks, readLeases, readAgents } from "../src/reads/tracker-reads.ts";
import { filterByScopes, TrackerReader } from "../src/reads/tracker.ts";

describe("tracker visibility -> console scope mapping (via filterByScopes)", () => {
	it("maps project/private/shared to the right scope and filters to the caller's grants", () => {
		const rows = [
			{ id: 1, project_name: "console" }, // -> project:console
			{ id: 2, project_name: null, visibility: "private", owner: "eli" }, // -> user:eli
			{ id: 3, project_name: null, visibility: "shared" }, // -> fleet
		];
		expect(filterByScopes(rows, ["fleet", "project:console"]).map((r) => r.id)).toEqual([1, 3]);
		expect(filterByScopes(rows, ["user:eli"]).map((r) => r.id)).toEqual([2]);
	});
});

describe("TrackerReader over a temp sqlite (read-only, scope-mapped)", () => {
	let dir: string;
	let dbPath: string;
	let reader: TrackerReader;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "console-tracker-"));
		dbPath = join(dir, "tasks.db");
		const db = new DatabaseSync(dbPath);
		db.exec(`
			create table projects (id integer primary key, name text, visibility text, archived_at text);
			create table tasks (id integer primary key, project_id integer, kind text, title text, status text,
				priority integer, up_next integer, rank real, parent_id integer, blocked_on text, assignee text,
				claimed_by text, claim_token text, lease_expires_at text, verification_status text, effort text,
				suggested_agent text, close_reason text, owner text, visibility text, updated_at text, body text);
			create table agents (handle text primary key, display_name text, host text, role text, lane text,
				capabilities text, autonomy text, active integer);
		`);
		db.prepare("insert into projects (id,name) values (1,'console')").run();
		db.prepare(
			"insert into tasks (id,project_id,title,status,owner,visibility,updated_at) values (1,1,'proj task','todo','parker','shared','2026-07-13')",
		).run();
		db.prepare(
			"insert into tasks (id,title,status,owner,visibility,updated_at) values (2,'eli private','todo','eli','private','2026-07-13')",
		).run();
		db.prepare(
			"insert into tasks (id,title,status,owner,visibility,updated_at) values (3,'shared','todo','parker','shared','2026-07-13')",
		).run();
		// active (future) lease
		db.prepare(
			"insert into tasks (id,title,status,claimed_by,claim_token,lease_expires_at,visibility) values (4,'doing','doing','janet','SECRET','2099-01-01T00:00:00Z','shared')",
		).run();
		// EXPIRED lease — must be filtered from /leases (codex P2)
		db.prepare(
			"insert into tasks (id,title,status,claimed_by,claim_token,lease_expires_at,visibility) values (5,'stale','doing','ghost','SECRET','2020-01-01T00:00:00Z','shared')",
		).run();
		// PRIVATE task that ALSO has a project — must NOT leak to a project-only caller (codex P0)
		db.prepare(
			"insert into tasks (id,project_id,title,status,owner,visibility,updated_at) values (6,1,'eli private in console','todo','eli','private','2026-07-13')",
		).run();
		db.prepare("insert into agents (handle,host,active) values ('janet','.202',1)").run();
		db.close();
		reader = new TrackerReader(dbPath);
	});
	afterAll(() => {
		reader.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("a project+fleet caller sees the project task and shared tasks, not eli's private", () => {
		const env = readTasks(reader, ["fleet", "project:console"]);
		const ids = env.items.map((i) => i["id"]);
		expect(ids).toContain(1); // project:console
		expect(ids).toContain(3); // shared -> fleet
		expect(ids).not.toContain(2); // eli private
	});

	it("a PRIVATE task in a project does NOT leak to a project-only caller (codex P0)", () => {
		const asProject = readTasks(reader, ["project:console"]).items.map((i) => i["id"]);
		expect(asProject).toContain(1); // shared-in-project task
		expect(asProject).not.toContain(6); // eli's private-in-project task — owner-only, not project
		const asEli = readTasks(reader, ["user:eli"]).items.map((i) => i["id"]);
		expect(asEli).toContain(6); // owner sees their own private task
	});

	it("leases are leasePublic (no claim_token), scoped, and exclude EXPIRED leases (codex P2)", () => {
		const env = readLeases(reader, ["fleet"]);
		expect(env.items).toHaveLength(1); // task 4 active; task 5 expired -> filtered
		expect(env.items[0]?.["worker"]).toBe("janet");
		expect(env.items[0]?.["task_id"]).toBe(4);
		expect("claim_token" in (env.items[0] ?? {})).toBe(false);
	});

	it("agents require fleet grant", () => {
		expect(readAgents(reader, ["fleet"]).items).toHaveLength(1);
		expect(readAgents(reader, ["user:nobody"]).items).toHaveLength(0);
	});

	it("reconciles only an exact top-level proposal envelope, never markers hidden in args", () => {
		const db = new DatabaseSync(dbPath);
		const requestId = "11111111-1111-4111-8111-111111111111";
		const requestHash = "a".repeat(64);
		const body = (envelope: Record<string, unknown>) =>
			`Console propose-not-commit request. Owners may promote it through the normal tracker flow.\n\n\`\`\`json\n${JSON.stringify(envelope, null, 2)}\n\`\`\``;
		db.prepare(
			"insert into tasks (id,project_id,kind,title,status,body) values (7,1,'idea','spoof','inbox',?)",
		).run(
			body({
				schema_version: 1,
				request_id: "attacker-request",
				proposed_by: "attacker",
				operation: "dashboard.save",
				request_hash: "b".repeat(64),
				args: {
					injected: { request_id: requestId, proposed_by: "victim", request_hash: requestHash },
				},
			}),
		);
		db.prepare(
			"insert into tasks (id,project_id,kind,title,status,body) values (8,1,'idea','real','inbox',?)",
		).run(
			body({
				schema_version: 1,
				request_id: requestId,
				proposed_by: "victim",
				operation: "dashboard.save",
				request_hash: requestHash,
				args: {},
			}),
		);
		db.close();
		expect(
			reader.findProposalTaskId({
				requestId,
				principalId: "victim",
				operation: "dashboard.save",
				requestHash,
				project: "console",
			}),
		).toBe(8);
	});
});
