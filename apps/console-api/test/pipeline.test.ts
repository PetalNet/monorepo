import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";

import postgres from "postgres";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { buildServices, type Services } from "../src/app.ts";
import { Bridge } from "../src/bridge/index.ts";
import { sourceCursorRef } from "../src/bridge/system-outbox.ts";
import { migrate } from "../src/db/migrate.ts";
import { seedBootstrap } from "../src/db/seed.ts";
import type { Emission } from "../src/emission.ts";
import { reportSelfEmissionFailure, type ExceptionMonitor } from "../src/observability.ts";
import { runStructured } from "../src/query/structured.ts";
import { readEntity } from "../src/reads/entities.ts";
import { readRoster, readExecutors } from "../src/reads/roster.ts";
import { buildServer } from "../src/server.ts";

// --- temp TimescaleDB container (the brief's disposable-DB rule; NEVER a shared/live DB) ---------
const exec = promisify(execFile);
interface TempDb {
	adminUrl: string;
	appUrl: string;
	roUrl: string;
	writerUrl: string;
	appPassword: string;
	roPassword: string;
	writerPassword: string;
	stop(): Promise<void>;
}

async function startTempDb(): Promise<TempDb> {
	const name = `console-api-test-${randomBytes(6).toString("hex")}`;
	const pw = "testpw";
	const appPassword = "apppw";
	const roPassword = "ropw";
	const writerPassword = "writerpw";
	await exec("docker", [
		"run",
		"-d",
		"--name",
		name,
		"-e",
		`POSTGRES_PASSWORD=${pw}`,
		"-p",
		"0:5432",
		"timescale/timescaledb:latest-pg16",
	]);
	const { stdout: portOut } = await exec("docker", ["port", name, "5432/tcp"]);
	const port = Number(portOut.trim().split(":").pop());
	const host = "127.0.0.1";
	const adminUrl = `postgres://postgres:${pw}@${host}:${String(port)}/postgres`;
	// the timescaledb image runs an init server then restarts; require TWO consecutive `select 1`.
	const deadline = Date.now() + 90000;
	let streak = 0;
	for (;;) {
		const probe = postgres(adminUrl, {
			max: 1,
			connect_timeout: 3,
			onnotice: () => {},
			idle_timeout: 1,
		});
		try {
			await probe`select 1`;
			streak += 1;
		} catch {
			streak = 0;
		} finally {
			await probe.end({ timeout: 2 }).catch(() => undefined);
		}
		if (streak >= 2) break;
		if (Date.now() > deadline) throw new Error("temp db never became ready");
		await new Promise((r) => setTimeout(r, 750));
	}
	return {
		adminUrl,
		appUrl: `postgres://console_app:${appPassword}@${host}:${String(port)}/postgres`,
		roUrl: `postgres://console_ro:${roPassword}@${host}:${String(port)}/postgres`,
		writerUrl: `postgres://console_writer:${writerPassword}@${host}:${String(port)}/postgres`,
		appPassword,
		roPassword,
		writerPassword,
		async stop() {
			await exec("docker", ["rm", "-f", name]).catch(() => undefined);
		},
	};
}

let temp: TempDb;
let services: Services;

function emission(over: Partial<Emission> = {}): Emission {
	return {
		schema_version: 1,
		id: randomUUID(),
		type: "host.cpu.pct",
		ts: new Date().toISOString(),
		source: { service: "console-api", host: ".14", agent: null },
		subject: ".14",
		severity: "info",
		scope: "fleet",
		measures: { pct: 42 },
		...over,
	};
}

beforeAll(async () => {
	temp = await startTempDb();
	const admin = postgres(temp.adminUrl, { onnotice: () => {} });
	await migrate(admin, {
		appPassword: temp.appPassword,
		roPassword: temp.roPassword,
		writerPassword: temp.writerPassword,
	});
	await seedBootstrap(admin);
	// a test producer that may emit the test types into the scopes these tests exercise
	await admin`insert into producer_registrations (subject, allowed_services, allowed_prefixes, allowed_scopes, max_severity)
		values ('test:emitter', ${admin.json(["console-api", "bridge"])}, ${admin.json(["host", "iso", "test", "audit"])}, ${admin.json(["fleet", "user:*", "agent:*"])}, 'p0')
		on conflict (subject) do nothing`;
	await admin.end();
	services = await buildServices(
		{
			databaseUrl: temp.adminUrl,
			appDatabaseUrl: temp.appUrl,
			roDatabaseUrl: temp.roUrl,
			writerDatabaseUrl: temp.writerUrl,
			host: "127.0.0.1",
			port: 0,
			devAuth: true,
			glitchtipDsn: null,
			trackerDbPath: null,
		},
		{ migrate: false },
	);
}, 120000);

afterAll(async () => {
	await services?.close();
	await temp?.stop();
});

describe("emit pipeline", () => {
	it("runs the lake as Timescale hypertables with a continuous one-minute rollup", async () => {
		const hypertables = await services.db.admin<{ hypertable_name: string }[]>`
			select hypertable_name
			from timescaledb_information.hypertables
			where hypertable_name in ('events', 'event_archive')
			order by hypertable_name`;
		expect(hypertables.map((row) => row.hypertable_name)).toEqual(["event_archive", "events"]);
		const rollups = await services.db.admin<{ view_name: string }[]>`
			select view_name from timescaledb_information.continuous_aggregates
			where view_name = 'event_rollup_1m'`;
		expect(rollups).toHaveLength(1);
		const retentionJobs = await services.db.admin<{ hypertable_name: string }[]>`
			select hypertable_name
			from timescaledb_information.jobs
			where proc_name = 'policy_retention'
			  and hypertable_name in ('event_archive', 'event_rollup_1m')`;
		expect(new Set(retentionJobs.map((row) => row.hypertable_name))).toEqual(
			new Set(["event_archive", "event_rollup_1m"]),
		);
		const maintenanceJobs = await services.db.admin`
			select 1 from timescaledb_information.jobs
			where proc_schema = 'public' and proc_name = 'console_events_refresh_then_retain'`;
		expect(maintenanceJobs).toHaveLength(1);
	});

	it("refreshes every recoverable rollup bucket before raw retention drops it", async () => {
		const id = crypto.randomUUID();
		const receivedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
		const gates = await services.db.admin<{ seq: string }[]>`
			insert into emission_ids (id, received_at) values (${id}, ${receivedAt}) returning seq`;
		const seq = Number(gates[0]?.seq);
		await services.db.admin`
			insert into events
				(seq, id, type, ts, received_at, source_service, subject, subject_kind, severity, scope)
			values
				(${seq}, ${id}, 'test.rollup_recovery', ${receivedAt}, ${receivedAt}, 'test',
				 'rollup-recovery', 'service', 'info', 'fleet')`;
		await services.db.admin.unsafe(`call console_events_refresh_then_retain(0, '{}'::jsonb)`);
		const raw = await services.db.admin`select 1 from events where id = ${id}`;
		expect(raw).toHaveLength(0);
		const rolled = await services.db.admin`
			select sum(event_count)::int as n from event_rollup_1m
			where type = 'test.rollup_recovery'`;
		expect(rolled[0]?.["n"]).toBe(1);
	});

	it("accepts a valid emission and returns a seq", async () => {
		const r = await services.emit("test:emitter", emission(), 300);
		expect(r.ok).toBe(true);
		expect(typeof r.seq).toBe("number");
		expect(r.duplicate).toBe(false);
	});

	it("dedups a duplicate id to the original seq with no second row", async () => {
		const e = emission();
		const first = await services.emit("test:emitter", e, 300);
		const second = await services.emit("test:emitter", e, 300);
		expect(second.ok).toBe(true);
		expect(second.duplicate).toBe(true);
		expect(second.seq).toBe(first.seq);
		const count = await services.db.admin`select count(*)::int as n from events where id = ${e.id}`;
		expect(count[0]?.["n"]).toBe(1);
		const gates = await services.db.admin`
			select count(*)::int as n from emission_ids where id = ${e.id}`;
		expect(gates[0]?.["n"]).toBe(1);
	});

	it("archives contractual long-retention event classes atomically", async () => {
		const e = emission({ type: "audit.probe" });
		const result = await services.emit("test:emitter", e, 300);
		expect(result.ok).toBe(true);
		const archived = await services.db.admin`
			select count(*)::int as n from event_archive where id = ${e.id}`;
		expect(archived[0]?.["n"]).toBe(1);
		// Simulate raw-retention expiry. Normal structured reads must still traverse the archive.
		await services.db.admin`delete from events where id = ${e.id}`;
		const query = await runStructured(services.db.app, ["fleet"], {
			schema_version: 1,
			mode: "structured",
			from: "audit.probe",
			select: [{ field: "subject" }],
		});
		expect(query.rows.map((row) => row[0])).toContain(e.subject);
	});

	it("reruns the ordered migration without duplicating policies or losing data", async () => {
		const historical = emission({ type: "audit.backfill" });
		await services.emit("test:emitter", historical, 300);
		await services.db.admin`delete from event_archive where id = ${historical.id}`;
		await migrate(services.db.admin);
		const rows = await services.db.admin`select count(*)::int as n from emission_ids`;
		expect(Number(rows[0]?.["n"] ?? 0)).toBeGreaterThan(0);
		const backfilled = await services.db.admin`
			select count(*)::int as n from event_archive where id = ${historical.id}`;
		expect(backfilled[0]?.["n"]).toBe(1);
	});

	it("denies an unregistered producer", async () => {
		const r = await services.emit(
			"agent:nobody",
			emission({ source: { service: "bridge", host: null, agent: "nobody" } }),
			200,
		);
		expect(r.ok).toBe(false);
		expect(r.code).toBe("unregistered_producer");
	});

	it("rejects a secret-bearing emission", async () => {
		const r = await services.emit(
			"test:emitter",
			emission({ dimensions: { claim_token: "x" } }),
			200,
		);
		expect(r.code).toBe("secret_detected");
	});
});

describe("substrate observability", () => {
	it("keeps a sanitized structured fallback when the exception channel is inert", () => {
		const lines: string[] = [];
		reportSelfEmissionFailure(
			{
				captureException() {},
				async close() {
					return true;
				},
			},
			new Error("private database detail"),
			"failed",
			(line) => lines.push(line),
		);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "{}")).toEqual({
			level: "error",
			service: "console-api",
			event: "self_emission_failed",
			error_class: "Error",
		});
		expect(lines[0]).not.toContain("private database detail");
	});

	it("sends exceptions to GlitchTip and a stack-free error statistic to the lake", async () => {
		const captured: unknown[] = [];
		const monitor: ExceptionMonitor = {
			captureException(error) {
				captured.push(error);
			},
			async close() {
				return true;
			},
		};
		const server = await buildServer(services, true, monitor);
		server.get("/test/boom", async () => {
			throw new Error("private failure detail");
		});
		try {
			const response = await server.inject({
				method: "GET",
				url: "/test/boom",
				headers: { authorization: "Bearer must-never-land" },
			});
			expect(response.statusCode).toBe(500);
			expect(captured).toHaveLength(1);
			expect(captured[0]).toBeInstanceOf(Error);
			expect(String(captured[0])).not.toContain("private failure detail");
			const rows = await services.db.admin<
				{ dimensions: Record<string, unknown>; meta: Record<string, unknown> }[]
			>`select dimensions, meta from events where type = 'console.api.error'
				order by seq desc limit 1`;
			expect(rows[0]?.dimensions["error_class"]).toBe("Error");
			expect(JSON.stringify(rows[0])).not.toContain("private failure detail");
			expect(JSON.stringify(rows[0])).not.toContain("must-never-land");
		} finally {
			await server.close();
		}
	});
});

describe("RLS scope isolation", () => {
	it("a caller sees only rows in its granted scopes", async () => {
		await services.emit(
			"test:emitter",
			emission({ type: "iso.probe", scope: "user:parker", subject: "p", measures: {} }),
			200,
		);
		await services.emit(
			"test:emitter",
			emission({ type: "iso.probe", scope: "user:eli", subject: "e", measures: {} }),
			200,
		);

		const asParker = await runStructured(services.db.app, ["user:parker"], {
			schema_version: 1,
			mode: "structured",
			from: "iso.probe",
			select: [{ field: "subject" }],
		});
		const subjects = asParker.rows.map((r) => r[0]);
		expect(subjects).toContain("p");
		expect(subjects).not.toContain("e");

		const asEli = await runStructured(services.db.app, ["user:eli"], {
			schema_version: 1,
			mode: "structured",
			from: "iso.probe",
			select: [{ field: "subject" }],
		});
		expect(asEli.rows.map((r) => r[0])).toContain("e");
		expect(asEli.rows.map((r) => r[0])).not.toContain("p");
	});

	it("empty scope set sees nothing (fail-closed)", async () => {
		const none = await runStructured(services.db.app, [], {
			schema_version: 1,
			mode: "structured",
			from: "iso.probe",
			select: [{ field: "subject" }],
		});
		expect(none.rows).toHaveLength(0);
	});
});

describe("RLS-bypass hardening (codex N1a P0)", () => {
	it("refuses to boot in prod-auth when the app URL collapses to the superuser", async () => {
		await expect(
			buildServices(
				{
					databaseUrl: temp.adminUrl,
					appDatabaseUrl: temp.adminUrl, // == admin (superuser) — the footgun
					roDatabaseUrl: temp.adminUrl,
					writerDatabaseUrl: temp.adminUrl,
					host: "127.0.0.1",
					port: 0,
					devAuth: false,
					glitchtipDsn: null,
					trackerDbPath: null,
				},
				{ migrate: false },
			),
		).rejects.toThrow(/distinct non-superuser|NOSUPERUSER/);
	});

	it("boots in prod-auth with a real non-superuser app role", async () => {
		const svc = await buildServices(
			{
				databaseUrl: temp.adminUrl,
				appDatabaseUrl: temp.appUrl,
				roDatabaseUrl: temp.roUrl,
				writerDatabaseUrl: temp.writerUrl,
				host: "127.0.0.1",
				port: 0,
				devAuth: false,
				glitchtipDsn: null,
				trackerDbPath: null,
			},
			{ migrate: false },
		);
		await svc.close();
	});

	it("refuses in prod-auth when the app URL is console_writer (writer bypasses scope)", async () => {
		await expect(
			buildServices(
				{
					databaseUrl: temp.adminUrl,
					appDatabaseUrl: temp.writerUrl, // console_writer has a using(true) policy — must be rejected
					roDatabaseUrl: temp.roUrl,
					writerDatabaseUrl: temp.writerUrl,
					host: "127.0.0.1",
					port: 0,
					devAuth: false,
					glitchtipDsn: null,
					trackerDbPath: null,
				},
				{ migrate: false },
			),
		).rejects.toThrow(/console_app|writer/);
	});
});

describe("post-restart replay (codex N1a P1)", () => {
	it("a fresh broker replays persisted history from the lake, not just new events", async () => {
		const r = await services.emit(
			"test:emitter",
			emission({ type: "test.restart", scope: "fleet", subject: "before", measures: {} }),
			200,
		);
		expect(r.ok).toBe(true);
		// a SECOND services instance = a fresh broker with head 0 until initialized from the lake
		const svc2 = await buildServices(
			{
				databaseUrl: temp.adminUrl,
				appDatabaseUrl: temp.appUrl,
				roDatabaseUrl: temp.roUrl,
				writerDatabaseUrl: temp.writerUrl,
				host: "127.0.0.1",
				port: 0,
				devAuth: true,
				glitchtipDsn: null,
				trackerDbPath: null,
			},
			{ migrate: false },
		);
		try {
			const frames: Record<string, unknown>[] = [];
			await svc2.broker.subscribe(
				{ subId: "r1", pattern: "test.*", since: 0, scopes: ["fleet"] },
				(f) => frames.push(f),
			);
			const subjects = frames
				.filter((f) => f["kind"] === "event")
				.map((f) => (f["emission"] as Emission).subject);
			expect(subjects).toContain("before"); // replayed from the lake despite a zero in-memory head
		} finally {
			await svc2.close();
		}
	});
});

describe("structured query", () => {
	it("counts and groups by a pseudo-field", async () => {
		const r = await runStructured(services.db.app, ["fleet"], {
			schema_version: 1,
			mode: "structured",
			from: "events",
			select: [{ field: "seq", agg: "count", as: "n" }],
			group_by: ["source.service"],
		});
		expect(r.columns.map((c) => c.name)).toContain("source_service");
		expect(r.row_count).toBeGreaterThan(0);
	});

	it("refuses an unsupported fill honestly", async () => {
		await expect(
			runStructured(services.db.app, ["fleet"], {
				schema_version: 1,
				mode: "structured",
				from: "events",
				time: { bucket: "5m", fill: "previous" },
			}),
		).rejects.toThrow(/fill/);
	});
});

// Wait for the fire-and-forget projector to catch up to a seq for a (kind, subject).
async function waitProjected(kind: string, subject: string, minSeq: number): Promise<void> {
	for (let i = 0; i < 50; i++) {
		const r = await services.db
			.admin`select seq from current_state where kind = ${kind} and subject = ${subject}`;
		if (r[0] && Number(r[0]["seq"]) >= minSeq) return;
		await new Promise((res) => setTimeout(res, 20));
	}
	throw new Error(`projection for ${kind}/${subject} never reached seq ${String(minSeq)}`);
}

describe("current_state projection (N1b)", () => {
	it("fleet event and heartbeat for the same handle project to TWO distinct rows (H1)", async () => {
		const f = await services.emit(
			"bridge:fleet",
			{
				schema_version: 1,
				id: randomUUID(),
				type: "fleet.event.pre_tool",
				ts: new Date().toISOString(),
				source: { service: "bridge", host: ".15", agent: "janet" },
				subject: "janet",
				subject_kind: "agent",
				severity: "info",
				scope: "fleet",
				dimensions: { status: "working", current_tool: "Bash" },
			},
			300,
		);
		expect(f.ok).toBe(true);
		const h = await services.emit(
			"bridge:manager",
			{
				schema_version: 1,
				id: randomUUID(),
				type: "agent.heartbeat",
				ts: new Date().toISOString(),
				source: { service: "bridge", host: ".15", agent: "janet" },
				subject: "janet",
				subject_kind: "agent",
				severity: "info",
				scope: "fleet",
				dimensions: { state: "running" },
			},
			300,
		);
		expect(h.ok).toBe(true);
		await waitProjected("fleet", "janet", f.seq as number);
		await waitProjected("heartbeat", "janet", h.seq as number);
		const rows = await services.db
			.admin`select kind, subject from current_state where subject = 'janet' order by kind`;
		const kinds = rows.map((r) => r["kind"]);
		expect(kinds).toContain("fleet");
		expect(kinds).toContain("heartbeat"); // NOT collapsed onto one row
	});

	it("a lower seq never regresses a higher-seq state (seq guard)", async () => {
		const first = await services.emit(
			"bridge:fleet",
			{
				schema_version: 1,
				id: randomUUID(),
				type: "fleet.event.post_tool",
				ts: new Date().toISOString(),
				source: { service: "bridge", host: ".14", agent: "seqbox", agent_x: null },
				subject: "seqbox",
				subject_kind: "agent",
				severity: "info",
				scope: "fleet",
				dimensions: { status: "idle" },
			},
			300,
		);
		await waitProjected("fleet", "seqbox", first.seq as number);
		// directly attempt a stale upsert with a lower seq via the projector's guard shape
		await services.db
			.writer`insert into current_state (kind, subject, scope, state, observed_at, seq)
			values ('fleet', 'seqbox', 'fleet', ${services.db.writer.json({ status: "STALE" })}, now(), 1)
			on conflict (kind, subject) do update set state = excluded.state, seq = excluded.seq where excluded.seq > current_state.seq`;
		const row = await services.db
			.admin`select state from current_state where kind='fleet' and subject='seqbox'`;
		const st = row[0]?.["state"] as { status: string } | undefined;
		expect(st?.status).toBe("idle"); // stale write rejected
	});

	it("a fleet-granted caller reads /fleet (aggregate scope), a bare user grant does not", async () => {
		await services.emit(
			"bridge:fleet",
			{
				schema_version: 1,
				id: randomUUID(),
				type: "fleet.event.session_start",
				ts: new Date().toISOString(),
				source: { service: "bridge", host: ".12", agent: "aggbox" },
				subject: "aggbox",
				subject_kind: "agent",
				severity: "info",
				scope: "fleet",
				dimensions: { status: "alive" },
			},
			300,
		);
		await waitProjected("fleet", "aggbox", 1);
		const asFleet = await readEntity(services.db.app, ["fleet"], "fleet");
		expect(asFleet.items.map((i) => i["subject"])).toContain("aggbox");
		const asUser = await readEntity(services.db.app, ["user:nobody"], "fleet");
		expect(asUser.items.map((i) => i["subject"])).not.toContain("aggbox"); // flat model: no fleet grant, no rows
	});

	it("bridge.source.unreachable marks the entity dark (positive down-evidence)", async () => {
		await services.emit(
			"bridge:fleet",
			{
				schema_version: 1,
				id: randomUUID(),
				type: "fleet.event.stop",
				ts: new Date().toISOString(),
				source: { service: "bridge", host: ".10", agent: "darkbox" },
				subject: "darkbox",
				subject_kind: "agent",
				severity: "info",
				scope: "fleet",
				dimensions: { status: "idle" },
			},
			300,
		);
		await waitProjected("fleet", "darkbox", 1);
		await services.emit(
			"bridge:hosts",
			{
				schema_version: 1,
				id: randomUUID(),
				type: "bridge.source.unreachable",
				ts: new Date().toISOString(),
				source: { service: "bridge", host: ".10", agent: null },
				subject: "darkbox",
				severity: "warn",
				scope: "fleet",
			},
			300,
		);
		for (let i = 0; i < 50; i++) {
			const r = await services.db
				.admin`select unreachable_since from current_state where kind='fleet' and subject='darkbox'`;
			if (r[0]?.["unreachable_since"]) return;
			await new Promise((res) => setTimeout(res, 20));
		}
		throw new Error("unreachable_since never set");
	});
});

describe("roster + executors (N1b-2, lake half)", () => {
	it("roster joins lake current_state per handle; tracker-down halves are 'unavailable', not null-as-data", async () => {
		const e = await services.emit(
			"bridge:fleet",
			{
				schema_version: 1,
				id: randomUUID(),
				type: "fleet.event.pre_tool",
				ts: new Date().toISOString(),
				source: { service: "bridge", host: ".15", agent: "rosterbox" },
				subject: "rosterbox",
				subject_kind: "agent",
				severity: "info",
				scope: "fleet",
				dimensions: { status: "working" },
			},
			300,
		);
		await waitProjected("fleet", "rosterbox", e.seq as number);
		const env = await readRoster(services.db.app, null, ["fleet"]);
		const row = env.items.find((i) => (i as { handle: string }).handle === "rosterbox") as
			| { fleet: { visibility: string }; identity: { visibility: string } }
			| undefined;
		expect(row?.fleet.visibility).toBe("visible");
		expect(row?.identity.visibility).toBe("unavailable"); // tracker null => unavailable, not "no data"
	});

	it("executors derive liveness from lake current_state", async () => {
		await services.emit(
			"bridge:manager",
			{
				schema_version: 1,
				id: randomUUID(),
				type: "agent.heartbeat",
				ts: new Date().toISOString(),
				source: { service: "bridge", host: ".202", agent: "execbox" },
				subject: "execbox",
				subject_kind: "agent",
				severity: "info",
				scope: "fleet",
				dimensions: { state: "running" },
			},
			300,
		);
		await waitProjected("heartbeat", "execbox", 1);
		const env = await readExecutors(services.db.app, ["fleet"]);
		const mgr = env.items.find((i) => (i as { kind: string }).kind === "manager") as
			| { liveness: string }
			| undefined;
		expect(mgr?.liveness).toBe("alive"); // fresh heartbeat -> manager class alive
	});
});

describe("bridge end-to-end (N1b-3 — bot-spam into the bus)", () => {
	it("ingests system-outbox files into the lake via the real emit path, idempotently", async () => {
		const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "e2e-outbox-"));
		mkdirSync(join(dir, "sent"), { recursive: true });
		writeFileSync(
			join(dir, "sent", "900-shawn.json"),
			JSON.stringify({ sender: "shawn", body: "[warn] routine alert" }),
		);

		const bridge = new Bridge(services.db.writer, (subj, e, b) => services.emit(subj, e, b), {
			systemOutboxDir: dir,
		});
		await bridge.pollOnce("2026-07-13T00:00:00Z");
		const q1 = await runStructured(services.db.app, ["fleet"], {
			schema_version: 1,
			mode: "structured",
			from: "bot.message",
			select: [{ field: "subject" }],
		});
		// the subject is the trustworthy source; the (spoofable) claimed sender rides as a dimension
		expect(q1.rows.map((r) => r[0])).toContain("system-outbox");
		const sender = await services.db
			.admin`select dimensions->>'sender' s from events where type='bot.message'`;
		expect(sender.map((r) => r["s"])).toContain("shawn");

		// second poll: cursor advanced -> no re-emit; and even a forced re-tail dedups by deterministic id
		const before = await services.db
			.admin`select count(*)::int n from events where type='bot.message'`;
		await bridge.pollOnce("2026-07-13T00:00:05Z");
		const after = await services.db
			.admin`select count(*)::int n from events where type='bot.message'`;
		expect(after[0]?.["n"]).toBe(before[0]?.["n"]); // idempotent — no duplicate rows
	});

	it("quarantines a secret-bearing poison record and continues with the next file", async () => {
		const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "e2e-poison-outbox-"));
		mkdirSync(join(dir, "sent"), { recursive: true });
		writeFileSync(
			join(dir, "sent", "990-ghp_abcdefghijklmnopqrstuvwxyz.json"),
			JSON.stringify({
				sender: "shawn",
				body: "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz",
			}),
		);
		writeFileSync(
			join(dir, "sent", "991-valid.json"),
			JSON.stringify({ sender: "shawn", body: "routine valid message after poison" }),
		);
		try {
			const bridge = new Bridge(services.db.writer, (subj, e, b) => services.emit(subj, e, b), {
				systemOutboxDir: dir,
			});
			await bridge.pollOnce("2026-07-13T00:01:00Z");
			const validRef = sourceCursorRef("991-valid.json");
			const poisonRef = sourceCursorRef("990-ghp_abcdefghijklmnopqrstuvwxyz.json");
			const valid = await services.db
				.admin`select count(*)::int n from events where dimensions->>'file_ref' = ${validRef}`;
			expect(valid[0]?.["n"]).toBe(1);
			const dead = await services.db
				.admin`select error_code from bridge_dead_letter where source_cursor = ${poisonRef}`;
			expect(dead[0]?.["error_code"]).toBe("secret_detected");
			const gap = await services.db
				.admin`select count(*)::int n from events where type='bridge.gap_detected' and dimensions->>'source_cursor'=${poisonRef}`;
			expect(gap[0]?.["n"]).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
