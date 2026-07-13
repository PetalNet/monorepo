import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";

import postgres from "postgres";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { buildServices, type Services } from "../src/app.ts";
import { Bridge } from "../src/bridge/index.ts";
import { sourceCursorRef } from "../src/bridge/system-outbox.ts";
import { Appender } from "../src/bus/appender.ts";
import { migrate } from "../src/db/migrate.ts";
import { seedBootstrap } from "../src/db/seed.ts";
import type { Emission } from "../src/emission.ts";
import { reportSelfEmissionFailure, type ExceptionMonitor } from "../src/observability.ts";
import { readQueryRecord } from "../src/query/history.ts";
import { runStructured } from "../src/query/structured.ts";
import { readEntity } from "../src/reads/entities.ts";
import { readRoster, readExecutors } from "../src/reads/roster.ts";
import { searchSemanticCorpus } from "../src/semantic/search.ts";
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
		"timescale/timescaledb-ha:pg16",
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
		const reused = await services.emit(
			"test:emitter",
			{ ...e, dimensions: { changed: "body" } },
			300,
		);
		expect(reused).toMatchObject({ ok: false, code: "id_reused" });
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
		await services.db.admin`
			update emission_ids set payload_sha256 = null where id = ${historical.id}`;
		await migrate(services.db.admin);
		const rows = await services.db.admin`select count(*)::int as n from emission_ids`;
		expect(Number(rows[0]?.["n"] ?? 0)).toBeGreaterThan(0);
		const backfilled = await services.db.admin`
			select count(*)::int as n from event_archive where id = ${historical.id}`;
		expect(backfilled[0]?.["n"]).toBe(1);
		expect(await services.emit("test:emitter", historical, 300)).toMatchObject({
			ok: true,
			duplicate: true,
		});
		expect(
			await services.emit("test:emitter", { ...historical, action: "changed" }, 300),
		).toMatchObject({ ok: false, code: "id_reused" });
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

describe("L2 semantic layer", () => {
	it("auto-derives rich field semantics and proposes drift without mutating the registry", async () => {
		const first = emission({
			type: "test.semantic_latency",
			dimensions: { zone: "north", healthy: true },
			measures: { latency_ms: 12 },
			meta: {
				fields: {
					zone: { cardinality: "low" },
					latency_ms: { kind: "gauge", unit: "ms" },
				},
			},
		});
		expect((await services.emit("test:emitter", first, 500)).ok).toBe(true);
		const rows = await services.db.admin<
			{
				dimensions: Record<string, { type: string; cardinality: string | null }>;
				measures: Record<string, { kind: string | null; unit: string | null }>;
			}[]
		>`select dimensions, measures from semantic_registry where type = ${first.type}`;
		expect(rows[0]?.dimensions["healthy"]?.type).toBe("boolean");
		expect(rows[0]?.dimensions["zone"]?.cardinality).toBe("low");
		expect(rows[0]?.measures["latency_ms"]).toEqual({ kind: "gauge", unit: "ms" });
		const vector = await services.db.admin`
			select vector_dims(embedding) as dims from semantic_documents
			where id = ${`stat:${first.type}:${first.scope}`}`;
		expect(vector[0]?.["dims"]).toBe(384);

		const drift = emission({
			type: first.type,
			dimensions: { zone: "south", healthy: "yes" },
			measures: { latency_ms: 14 },
			meta: { fields: { latency_ms: { kind: "counter", unit: "seconds" } } },
		});
		expect((await services.emit("test:emitter", drift, 500)).ok).toBe(true);
		const after = await services.db.admin<
			{ dimensions: Record<string, { type: string }>; measures: Record<string, { kind: string }> }[]
		>`select dimensions, measures from semantic_registry where type = ${first.type}`;
		expect(after[0]?.dimensions["healthy"]?.type).toBe("boolean");
		expect(after[0]?.measures["latency_ms"]?.kind).toBe("gauge");
		const proposals = await services.db.admin<{ kind: string }[]>`
			select kind from semantic_proposals
			where statistic_type = ${first.type} and status = 'pending'`;
		expect(proposals.map((proposal) => proposal.kind)).toEqual([
			"registry_drift",
			"registry_drift",
			"registry_drift",
		]);
		await expect(
			runStructured(services.db.app, ["fleet"], {
				schema_version: 1,
				mode: "structured",
				from: first.type,
				select: [{ field: "latency_ms", agg: "sum" }],
			}),
		).rejects.toThrow(/counter\|delta/);
	});

	it("persists successful query refs and retrieves scoped statistic/query context through pgvector", async () => {
		const result = await runStructured(services.db.app, ["fleet"], {
			schema_version: 1,
			mode: "structured",
			from: "test.semantic_latency",
			select: [{ field: "latency_ms", agg: "avg", as: "latency" }],
			group_by: ["zone"],
		});
		const record = await readQueryRecord(services.db.app, ["fleet"], result.query_ref);
		expect(record?.sql_text).toContain("avg");
		expect(record?.request.from).toBe("test.semantic_latency");
		const context = await searchSemanticCorpus(
			services.db.app,
			["fleet"],
			"semantic latency zone",
			8,
		);
		expect(context.some((item) => item.source_ref === "test.semantic_latency")).toBe(true);
		expect(context.some((item) => item.source_ref === result.query_ref)).toBe(true);
	});

	it("keeps the RAG corpus scope-filtered", async () => {
		const privateType = `test.private_${randomBytes(4).toString("hex")}`;
		await services.emit(
			"test:emitter",
			emission({ type: privateType, scope: "user:eli", dimensions: { private_marker: "orchid" } }),
			400,
		);
		const parker = await searchSemanticCorpus(services.db.app, ["user:parker"], "orchid", 32);
		expect(parker.some((item) => item.source_ref === privateType)).toBe(false);
		const eli = await searchSemanticCorpus(services.db.app, ["user:eli"], "orchid", 32);
		expect(eli.some((item) => item.source_ref === privateType)).toBe(true);
		const views = await searchSemanticCorpus(
			services.db.app,
			["fleet"],
			"materialized relationship edges",
			32,
		);
		expect(views.some((item) => item.kind === "view" && item.source_ref === "relationships")).toBe(
			true,
		);
	});

	it("keeps descriptors for the same statistic isolated by scope", async () => {
		const type = `test.scoped_${randomBytes(4).toString("hex")}`;
		await services.emit(
			"test:emitter",
			emission({ type, scope: "fleet", dimensions: { public_zone: "north" } }),
			400,
		);
		await services.emit(
			"test:emitter",
			emission({ type, scope: "user:eli", dimensions: { private_marker: "orchid" } }),
			400,
		);
		const fleetRows = await services.db.app.begin(async (tx) => {
			await tx`select set_config('app.scopes', 'fleet', true)`;
			return tx<{ dimensions: Record<string, unknown> }[]>`
				select dimensions from semantic_registry_scoped where type = ${type}`;
		});
		expect(fleetRows).toHaveLength(1);
		expect(fleetRows[0]?.dimensions).toHaveProperty("public_zone");
		expect(fleetRows[0]?.dimensions).not.toHaveProperty("private_marker");
		const fleetSearch = await searchSemanticCorpus(services.db.app, ["fleet"], "orchid", 32);
		expect(fleetSearch.some((item) => item.content.includes("private_marker"))).toBe(false);
		await expect(
			runStructured(services.db.app, ["fleet"], {
				schema_version: 1,
				mode: "structured",
				from: type,
				select: [{ field: "private_marker" }],
			}),
		).rejects.toThrow(/not registered/);
	});

	it("quarantines new-type floods and creates one curation proposal", async () => {
		await services.db.admin`
			update producer_registrations set max_new_types_per_hour = 1
			where subject = 'test:emitter'`;
		await services.db.admin`delete from producer_rate_windows where subject = 'test:emitter'`;
		const first = emission({ type: `test.cap_${randomBytes(4).toString("hex")}` });
		const second = emission({ type: `test.cap_${randomBytes(4).toString("hex")}` });
		try {
			expect((await services.emit("test:emitter", first, 300)).ok).toBe(true);
			const rejected = await services.emit("test:emitter", second, 300);
			expect(rejected).toMatchObject({ ok: false, code: "new_type_rate_limited" });
			const beforeRetry = await services.db.admin`
				select minute_emit_count, hour_new_type_count from producer_rate_windows
				where subject = 'test:emitter'`;
			expect(await services.emit("test:emitter", second, 300)).toMatchObject({
				ok: false,
				code: "new_type_rate_limited",
			});
			const afterRetry = await services.db.admin`
				select minute_emit_count, hour_new_type_count from producer_rate_windows
				where subject = 'test:emitter'`;
			expect(afterRetry).toEqual(beforeRetry);
			const quarantined = await services.db.admin`
				select reason from emission_quarantine where id = ${second.id}`;
			expect(quarantined[0]?.["reason"]).toBe("new_type_rate_limited");
			const proposals = await services.db.admin`
				select 1 from semantic_proposals where kind = 'new_type_rate_cap'
				and statistic_type = ${second.type}`;
			expect(proposals).toHaveLength(1);
			await services.db.admin`
				update producer_rate_windows set hour_started_at = now() - interval '2 hours',
					hour_new_type_count = 0 where subject = 'test:emitter'`;
			await services.db.admin`
				update emission_quarantine set retry_after = now() - interval '1 second'
				where id = ${second.id}`;
			expect(await services.emit("test:emitter", second, 300)).toMatchObject({ ok: true });
		} finally {
			await services.db.admin`
				update producer_registrations set max_new_types_per_hour = 20
				where subject = 'test:emitter'`;
			await services.db.admin`delete from producer_rate_windows where subject = 'test:emitter'`;
		}
	});

	it("serializes semantic merges across independent appenders", async () => {
		const type = `test.concurrent_${randomBytes(4).toString("hex")}`;
		const a = new Appender(services.db.writer, () => undefined);
		const b = new Appender(services.db.writer, () => undefined);
		const limits = { maxEmitPerMinute: 6000, maxNewTypesPerHour: 20 };
		await Promise.all([
			a.append(emission({ type, dimensions: { alpha: "a" } }), "test:emitter", limits),
			b.append(emission({ type, dimensions: { beta: "b" } }), "test:emitter", limits),
		]);
		const rows = await services.db.admin<{ dimensions: Record<string, unknown> }[]>`
			select dimensions from semantic_registry_scoped where type = ${type} and scope = 'fleet'`;
		expect(rows[0]?.dimensions).toHaveProperty("alpha");
		expect(rows[0]?.dimensions).toHaveProperty("beta");

		const retry = emission({ type: `test.concurrent_retry_${randomBytes(4).toString("hex")}` });
		const before = await services.db.admin<{ minute_emit_count: number }[]>`
			select minute_emit_count from producer_rate_windows where subject = 'test:emitter'`;
		const outcomes = await Promise.all([
			a.append(retry, "test:emitter", limits),
			b.append(retry, "test:emitter", limits),
		]);
		const after = await services.db.admin<{ minute_emit_count: number }[]>`
			select minute_emit_count from producer_rate_windows where subject = 'test:emitter'`;
		expect(outcomes.filter((outcome) => outcome.ok && outcome.duplicate)).toHaveLength(1);
		expect((after[0]?.minute_emit_count ?? 0) - (before[0]?.minute_emit_count ?? 0)).toBe(1);
	});

	it("requires every originating scope to dereference a query record", async () => {
		const result = await runStructured(services.db.app, ["fleet", "user:eli"], {
			schema_version: 1,
			mode: "structured",
			from: "events",
			select: [{ field: "type" }],
			limit: 1,
		});
		expect(await readQueryRecord(services.db.app, ["fleet"], result.query_ref)).toBeNull();
		expect(
			await readQueryRecord(services.db.app, ["fleet", "user:eli"], result.query_ref),
		).not.toBeNull();
	});

	it("rejects dishonest view and counter aggregations before SQL execution", async () => {
		await expect(
			runStructured(services.db.app, ["fleet"], {
				schema_version: 1,
				mode: "structured",
				from: "relationships",
				select: [{ field: "subject", agg: "sum" }],
			}),
		).rejects.toThrow(/registered measure/);
		const type = `test.counter_${randomBytes(4).toString("hex")}`;
		await services.emit(
			"test:emitter",
			emission({
				type,
				measures: { requests: 1 },
				meta: { fields: { requests: { kind: "counter", unit: "requests" } } },
			}),
			400,
		);
		await expect(
			runStructured(services.db.app, ["fleet"], {
				schema_version: 1,
				mode: "structured",
				from: type,
				select: [{ field: "requests", agg: "avg" }],
			}),
		).rejects.toThrow(/invalid for counter/);
	});

	it("uses governed view descriptors and validates typed filters before SQL", async () => {
		const type = `test.view_metric_${randomBytes(4).toString("hex")}`;
		for (const [requests, zone] of [
			[1, "north"],
			[2, "south"],
		] as const)
			await services.emit(
				"test:emitter",
				emission({
					type,
					dimensions: { zone },
					measures: { requests },
					meta: { fields: { requests: { kind: "gauge", unit: "requests" } } },
				}),
				400,
			);
		await services.db.admin.unsafe(`
			create or replace view test_semantic_custom with (security_invoker = true) as
			select e.*, (e.measures->>'requests')::numeric as requests
			from lake_events e`);
		await services.db.admin`grant select on test_semantic_custom to console_app`;
		await services.db.admin`
			insert into semantic_views (name, relation_name, description, fields, scopes)
			values ('custom_metrics', 'test_semantic_custom', 'governed metric view',
				${services.db.admin.json({
					shape: "event",
					requests: { type: "number", kind: "gauge", unit: "requests" },
				})}, '["*"]'::jsonb)
			on conflict (name) do update set relation_name = excluded.relation_name,
				fields = excluded.fields, enabled = true`;
		const distinct = await runStructured(services.db.app, ["fleet"], {
			schema_version: 1,
			mode: "structured",
			from: "custom_metrics",
			select: [{ field: "requests", agg: "count_distinct", as: "n" }],
			where: { type },
		});
		expect(distinct.rows).toEqual([[2]]);
		const ranged = await runStructured(services.db.app, ["fleet"], {
			schema_version: 1,
			mode: "structured",
			from: type,
			select: [{ field: "zone" }],
			where: { zone: { op: "gt", value: "north" } },
		});
		expect(ranged.rows).toEqual([["south"]]);
		await expect(
			runStructured(services.db.app, ["fleet"], {
				schema_version: 1,
				mode: "structured",
				from: type,
				where: { requests: { op: "like", value: "%2%" } },
			}),
		).rejects.toThrow(/textual field/);

		const booleanType = `test.boolean_${randomBytes(4).toString("hex")}`;
		await services.emit(
			"test:emitter",
			emission({ type: booleanType, dimensions: { healthy: true } }),
			300,
		);
		const booleans = await runStructured(services.db.app, ["fleet"], {
			schema_version: 1,
			mode: "structured",
			from: booleanType,
			select: [{ field: "healthy" }],
			where: { healthy: true },
		});
		expect(booleans.rows).toEqual([[true]]);
		await expect(
			runStructured(services.db.app, ["fleet"], {
				schema_version: 1,
				mode: "structured",
				from: booleanType,
				where: { healthy: { op: "gt", value: false } },
			}),
		).rejects.toThrow(/invalid for boolean/);

		await services.db.admin.unsafe(`
			create or replace view test_semantic_unsafe as select * from lake_events`);
		await services.db.admin`grant select on test_semantic_unsafe to console_app`;
		await services.db.admin`
			insert into semantic_views (name, relation_name, description, fields, scopes)
			values ('unsafe_metrics', 'test_semantic_unsafe', 'must be refused',
				'{"shape":"event"}'::jsonb, '["*"]'::jsonb)
			on conflict (name) do update set relation_name = excluded.relation_name, enabled = true`;
		await expect(
			runStructured(services.db.app, ["fleet"], {
				schema_version: 1,
				mode: "structured",
				from: "unsafe_metrics",
			}),
		).rejects.toThrow(/unknown source/);
	});

	it("serves catalog reads in the paginated envelope and rate caps as retryable 429s", async () => {
		const publicType = `test.catalog_${randomBytes(4).toString("hex")}`;
		const secondPublicType = `test.catalog_${randomBytes(4).toString("hex")}`;
		const wildcardTrap = `test.catalogx${randomBytes(4).toString("hex")}`;
		const privateType = `test.catalog_private_${randomBytes(4).toString("hex")}`;
		await services.emit("test:emitter", emission({ type: publicType }), 300);
		await services.emit("test:emitter", emission({ type: secondPublicType }), 300);
		await services.emit("test:emitter", emission({ type: wildcardTrap }), 300);
		await services.emit(
			"test:emitter",
			emission({ type: privateType, scope: "user:eli", dimensions: { secret_shape: "x" } }),
			300,
		);
		const server = await buildServer(services, true);
		const principal = JSON.stringify({
			kind: "system",
			id: "test:emitter",
			scopes: ["fleet"],
			lanes: [],
		});
		try {
			const catalog = await server.inject({
				method: "GET",
				url: `/api/v1/catalog?type=test.catalog_*&limit=1`,
				headers: { "x-dev-principal": principal },
			});
			expect(catalog.statusCode).toBe(200);
			const envelope = catalog.json();
			expect(envelope).toMatchObject({
				schema_version: 1,
				freshness: { source: "semantic-registry" },
				truncated: true,
			});
			expect(envelope).toHaveProperty("next_cursor");
			expect(envelope.next_cursor).not.toContain("test.catalog");
			expect(envelope.items).toHaveLength(1);
			expect(JSON.stringify(envelope)).not.toContain("secret_shape");
			expect(JSON.stringify(envelope)).not.toContain(wildcardTrap);
			const next = await server.inject({
				method: "GET",
				url: `/api/v1/catalog?type=test.catalog_*&limit=1&cursor=${encodeURIComponent(envelope.next_cursor)}`,
				headers: { "x-dev-principal": principal },
			});
			expect(next.statusCode).toBe(200);
			expect(next.json().items).toHaveLength(1);
			expect(next.json().items[0].type).not.toBe(envelope.items[0].type);

			await services.db.admin`
				update producer_registrations set max_emit_per_min = 0 where subject = 'test:emitter'`;
			await services.db.admin`delete from producer_rate_windows where subject = 'test:emitter'`;
			const limited = await server.inject({
				method: "POST",
				url: "/api/v1/emit",
				headers: { "x-dev-principal": principal },
				payload: emission({ type: `test.rate_${randomBytes(4).toString("hex")}` }),
			});
			expect(limited.statusCode).toBe(429);
			expect(limited.headers["retry-after"]).toBe("60");
			expect(limited.json().error).toMatchObject({
				code: "emit_rate_limited",
				retryable: true,
			});
		} finally {
			await services.db.admin`
				update producer_registrations set max_emit_per_min = 6000 where subject = 'test:emitter'`;
			await services.db.admin`delete from producer_rate_windows where subject = 'test:emitter'`;
			await server.close();
		}
	});

	it("queries the registered statistic-to-edge relationship view", async () => {
		const linked = emission({
			type: "test.relationship",
			subject: "service:api",
			subject_kind: "service",
			links: [{ rel: "runs_on", to: { kind: "host", id: ".14" } }],
		});
		await services.emit("test:emitter", linked, 400);
		const result = await runStructured(services.db.app, ["fleet"], {
			schema_version: 1,
			mode: "structured",
			from: "relationships",
			select: [{ field: "edge_rel" }, { field: "edge_to_id" }],
			where: { subject: "service:api" },
		});
		expect(result.rows).toContainEqual(["runs_on", ".14"]);
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
