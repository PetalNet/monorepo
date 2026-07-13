import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";

import postgres from "postgres";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { buildServices, type Services } from "../src/app.ts";
import { migrate } from "../src/db/migrate.ts";
import { seedBootstrap } from "../src/db/seed.ts";
import type { Emission } from "../src/emission.ts";
import { runStructured } from "../src/query/structured.ts";
import { readEntity } from "../src/reads/entities.ts";
import { readRoster, readExecutors } from "../src/reads/roster.ts";

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
		values ('test:emitter', ${admin.json(["console-api", "bridge"])}, ${admin.json(["host", "iso", "test"])}, ${admin.json(["fleet", "user:*", "agent:*"])}, 'p0')
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
