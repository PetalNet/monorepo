import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { promisify } from "node:util";

import postgres from "postgres";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { buildServices, type Services } from "../src/app.ts";
import { AssistantCompilerError, type AssistantCompiler } from "../src/assistant/compiler.ts";
import { ask } from "../src/assistant/engine.ts";
import { AssistantRuntime, ClaudeCodeAssistantManager } from "../src/assistant/runtime.ts";
import { resolveBearer, sha256 } from "../src/auth/principal.ts";
import { TrackerProposalWriter } from "../src/auth/proposals.ts";
import type { BetterAuthSessionVerifier } from "../src/auth/session.ts";
import { Bridge } from "../src/bridge/index.ts";
import { sourceCursorRef } from "../src/bridge/system-outbox.ts";
import { Appender } from "../src/bus/appender.ts";
import { migrate } from "../src/db/migrate.ts";
import { assertRuntimeRolesHardened, openDb } from "../src/db/pool.ts";
import { seedBootstrap } from "../src/db/seed.ts";
import type { Emission } from "../src/emission.ts";
import { DoormanKeyCeremonyClient } from "../src/network/key-ceremony.ts";
import { reportSelfEmissionFailure, type ExceptionMonitor } from "../src/observability.ts";
import { readQueryRecord } from "../src/query/history.ts";
import { runStructured } from "../src/query/structured.ts";
import { readEntity } from "../src/reads/entities.ts";
import { readRoster, readExecutors } from "../src/reads/roster.ts";
import { searchSemanticCorpus } from "../src/semantic/search.ts";
import {
	buildServer,
	resolvedOpCapabilities,
	validateJsonSchema,
	type TerminalAdapter,
} from "../src/server.ts";

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
const capturedServiceExceptions: unknown[] = [];
const internalServiceErrors: string[] = [];
const deliverySends: { owner: string; target: string; body: string }[] = [];

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
		values ('test:emitter', ${admin.json(["console-api", "bridge"])}, ${admin.json(["host", "iso", "test", "audit", "service", "comms"])}, ${admin.json(["fleet", "user:*", "agent:*"])}, 'p0')
		on conflict (subject) do nothing`;
	await admin`insert into grants (subject, relation, object, granted_by)
		select 'test:emitter', 'editor', scope, 'test'
		from unnest(array['fleet', 'user:eli', 'user:parker', 'user:secret', 'user:public']) as scope`;
	await admin`insert into grants (subject, relation, object, granted_by) values
		('tester', 'editor', 'fleet', 'test'),
		('binding-user', 'editor', 'fleet', 'test'),
		('author', 'editor', 'user:public', 'test'),
		('system:console-api', 'editor', 'user:eli', 'test')`;
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
		{
			migrate: false,
			matrixTransport: {
				async assertOwnedTarget() {},
				async send(owner, target, body) {
					deliverySends.push({ owner, target, body });
					return { eventId: `$test-${String(deliverySends.length)}`, roomId: "!test:local" };
				},
			},
			monitor: {
				captureException(error) {
					capturedServiceExceptions.push(error);
				},
				async close() {
					return true;
				},
			},
			writeInternalError(line) {
				internalServiceErrors.push(line);
			},
		},
	);
}, 120000);

afterAll(async () => {
	await services?.close();
	await temp?.stop();
});

describe("doorman key ceremony", () => {
	it("resolves the enrolled handle by fingerprint before revoking and audits the real adapter result", async () => {
		const fingerprint = randomBytes(32).toString("hex");
		const requestEvent = emission({
			type: "edge.enroll.request",
			source: { service: "doorman", host: ".14", agent: null },
			subject: fingerprint,
			dimensions: { pubkey_fp: fingerprint },
			meta: {
				retention_class: "audit",
				entity: {
					pubkey_fp: fingerprint,
					requested_handle: "mc34",
					source_ip: "10.0.0.34",
					first_seen_at: new Date().toISOString(),
					state: "pending",
				},
			},
		});
		const requested = await services.emit(
			"bridge:doorman",
			requestEvent,
			Buffer.byteLength(JSON.stringify(requestEvent)),
		);
		expect(requested.ok).toBe(true);
		await waitProjected("edge", fingerprint, requested.seq as number);
		const event = emission({
			type: "edge.enroll.approved",
			source: { service: "doorman", host: ".14", agent: null },
			subject: fingerprint,
			dimensions: { pubkey_fp: fingerprint },
			meta: {
				retention_class: "audit",
				entity: { pubkey_fp: fingerprint, handle: "mc34", state: "enrolled" },
			},
		});
		const emitted = await services.emit(
			"bridge:doorman",
			event,
			Buffer.byteLength(JSON.stringify(event)),
		);
		expect(emitted.ok).toBe(true);
		await waitProjected("edge", fingerprint, emitted.seq as number);

		const requests: Array<{ url: string; body: Record<string, string> | null }> = [];
		const adapter = new DoormanKeyCeremonyClient({
			url: "http://127.0.0.1:8043/v1/key-ceremony/",
			token: "test-token",
			fetch: async (input, init) => {
				const url = String(input);
				requests.push({
					url,
					body: init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : null,
				});
				if (url.endsWith("/health")) return Response.json({ ok: true });
				return Response.json({
					ok: true,
					result: {
						pubkey_fp: fingerprint,
						handle: "mc34",
						state: "revoked",
						applied_at: new Date().toISOString(),
					},
				});
			},
		});
		const server = await buildServer({ ...services, keyCeremony: adapter }, true);
		const opId = randomUUID();
		try {
			const attentionRows = await services.db.admin<{ seq: string }[]>`
				select seq from events where type = 'attention.resolved'
				  and dimensions->>'pubkey_fp' = ${fingerprint} order by seq desc limit 1`;
			await waitProjected("attention", `edge-enroll:${fingerprint}`, Number(attentionRows[0]!.seq));
			const principal = {
				kind: "human",
				id: "parker",
				tiers: ["owner"],
				lanes: ["viewer", "editor", "operator", "admin"],
				scopes: ["fleet"],
			};
			const adminAttention = await server.inject({
				method: "GET",
				url: "/api/v1/attention",
				headers: { "x-dev-principal": JSON.stringify(principal) },
			});
			const viewerAttention = await server.inject({
				method: "GET",
				url: "/api/v1/attention",
				headers: {
					"x-dev-principal": JSON.stringify({ ...principal, lanes: ["viewer"] }),
				},
			});
			expect(adminAttention.json().items).toEqual(
				expect.arrayContaining([expect.objectContaining({ id: `edge-enroll:${fingerprint}` })]),
			);
			expect(viewerAttention.json().items).not.toEqual(
				expect.arrayContaining([expect.objectContaining({ id: `edge-enroll:${fingerprint}` })]),
			);

			const response = await server.inject({
				method: "POST",
				url: "/api/v1/op",
				headers: {
					"content-type": "application/json",
					"x-dev-principal": JSON.stringify(principal),
				},
				payload: {
					schema_version: 1,
					id: opId,
					op: "edge.key.revoke",
					args: { pubkey_fp: fingerprint, confirm_name: "mc34" },
					reason: "device retired",
					dry_run: false,
				},
			});
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({ ok: true, status: "applied" });
			expect(requests.at(-1)).toMatchObject({
				url: "http://127.0.0.1:8043/v1/key-ceremony/revoke",
				body: { pubkey_fp: fingerprint, handle: "mc34", reason: "device retired" },
			});
			const audit = await services.db.admin<{ present: boolean }[]>`
				select exists(select 1 from events where type = 'audit.op.outcome'
				  and meta->>'in_reply_to' = ${opId}) as present`;
			expect(audit[0]?.present).toBe(true);
		} finally {
			await server.close();
		}
	});
});

describe("services availability read", () => {
	it("derives scoped tri-state service rows and validates the response contract", async () => {
		const suffix = randomBytes(4).toString("hex");
		const degradedSubject = `.202/matrix-${suffix}`;
		const downSubject = `.15/library-${suffix}`;
		const malformedSubject = `.14/malformed-${suffix}`;
		const projected = new Map<string, number>();
		for (const [subject, ok, latency] of [
			[degradedSubject, true, 610],
			[degradedSubject, true, 720],
			[degradedSubject, true, 880],
			[downSubject, false, 0],
			[downSubject, false, 0],
			[downSubject, false, 0],
		] as const) {
			const result = await services.emit(
				"test:emitter",
				emission({
					type: "service.probe",
					source: {
						service: "bridge",
						host: subject.split("/")[0] ?? null,
						agent: "janet",
					},
					subject,
					subject_kind: "service",
					dimensions: {
						ok,
						service: subject.split("/")[1] ?? subject,
					},
					measures: {
						latency_ms: latency,
						cadence_s: 30,
						degraded_threshold_ms: 500,
					},
				}),
				500,
			);
			expect(result.ok).toBe(true);
			projected.set(subject, result.seq as number);
		}
		const malformed = await services.emit(
			"test:emitter",
			emission({
				type: "service.probe",
				source: { service: "bridge", host: ".14", agent: "janet" },
				subject: malformedSubject,
				subject_kind: "service",
				dimensions: { ok: "unknown", service: `malformed-${suffix}` },
				measures: { cadence_s: 30, degraded_threshold_ms: 500 },
			}),
			500,
		);
		expect(malformed.ok).toBe(true);
		projected.set(malformedSubject, malformed.seq as number);
		for (const [subject, seq] of projected) await waitProjected("availability", subject, seq);

		const server = await buildServer(services, true);
		try {
			const visible = await server.inject({
				method: "GET",
				url: "/api/v1/availability?window=24h",
				headers: {
					"x-dev-principal": JSON.stringify({
						kind: "human",
						id: "tester",
						lanes: ["viewer"],
						scopes: ["fleet"],
					}),
				},
			});
			expect(visible.statusCode, visible.body).toBe(200);
			const body = visible.json();
			const availabilitySchema = JSON.parse(
				readFileSync(
					new URL("../docs/contracts/schemas/availability.schema.json", import.meta.url),
					"utf8",
				),
			) as Record<string, unknown>;
			expect(validateJsonSchema(body, availabilitySchema, "availability")).toBeNull();
			expect(body.items).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						subject: degradedSubject,
						state: "degraded",
						p50_latency_ms: 720,
					}),
					expect.objectContaining({ subject: downSubject, state: "down", uptime_pct: 0 }),
					expect.objectContaining({
						subject: malformedSubject,
						state: "down",
						invalid_probes: 1,
						source_error: "1 probe result is unreadable in this window",
					}),
				]),
			);

			const hidden = await server.inject({
				method: "GET",
				url: "/api/v1/availability?window=24h",
				headers: {
					"x-dev-principal": JSON.stringify({
						kind: "human",
						id: "hidden",
						lanes: ["viewer"],
						scopes: ["user:hidden"],
					}),
				},
			});
			expect(hidden.json().items).toEqual([]);
			const badWindow = await server.inject({
				method: "GET",
				url: "/api/v1/availability?window=forever",
				headers: {
					"x-dev-principal": JSON.stringify({ kind: "human", id: "tester", scopes: ["fleet"] }),
				},
			});
			expect(badWindow.statusCode).toBe(400);
		} finally {
			await server.close();
		}
	});
});

describe("correspondence history read", () => {
	it("normalizes persisted comms, filters on the server, and keeps RLS boundaries", async () => {
		const taskId = 880_000 + Math.floor(Math.random() * 10_000);
		const cardId = `card-${String(taskId)}`;
		const card = emission({
			type: "comms.card",
			source: { service: "console-api", host: ".14", agent: "janet" },
			subject: "carson-2",
			subject_kind: "agent",
			task_id: taskId,
			dimensions: { recipient: "carson-2", card_id: cardId, method: "task.dispatch" },
		});
		const rpc = emission({
			type: "comms.rpc",
			source: { service: "console-api", host: ".14", agent: "carson-2" },
			subject: "janet",
			subject_kind: "agent",
			task_id: taskId,
			dimensions: {
				recipient: "janet",
				in_reply_to: card.id,
				method: "task.dispatch.response",
			},
		});
		expect((await services.emit("test:emitter", card, 500)).ok).toBe(true);
		expect((await services.emit("test:emitter", rpc, 500)).ok).toBe(true);

		const server = await buildServer(services, true);
		const visibleHeaders = {
			"x-dev-principal": JSON.stringify({ kind: "human", id: "tester", scopes: ["fleet"] }),
		};
		try {
			const response = await server.inject({
				method: "GET",
				url: `/api/v1/comms?type=task-card&agent=janet&task_id=${String(taskId)}`,
				headers: visibleHeaders,
			});
			expect(response.statusCode, response.body).toBe(200);
			const body = response.json();
			expect(body).toMatchObject({ schema_version: 1, truncated: false });
			expect(body.items).toEqual([
				expect.objectContaining({
					id: card.id,
					method: "comms.card",
					sender: "janet",
					recipient: "carson-2",
					task_id: taskId,
					card_id: cardId,
					about: "task.dispatch",
				}),
			]);
			const itemSchema = JSON.parse(
				readFileSync(
					new URL("../docs/contracts/schemas/entities/comms-event.schema.json", import.meta.url),
					"utf8",
				),
			) as Record<string, unknown>;
			expect(validateJsonSchema(body.items[0], itemSchema, "comms item")).toBeNull();

			const reply = await server.inject({
				method: "GET",
				url: `/api/v1/comms?type=rpc&agent=janet&task_id=${String(taskId)}`,
				headers: visibleHeaders,
			});
			expect(reply.json().items).toEqual([
				expect.objectContaining({ id: rpc.id, in_reply_to: card.id }),
			]);
			const firstPage = await server.inject({
				method: "GET",
				url: `/api/v1/comms?task_id=${String(taskId)}&limit=1`,
				headers: visibleHeaders,
			});
			const firstPageBody = firstPage.json();
			expect(firstPageBody).toMatchObject({ truncated: true, next_cursor: expect.any(String) });
			expect(firstPageBody.next_cursor).not.toMatch(/^\d+$/);
			const secondPage = await server.inject({
				method: "GET",
				url: `/api/v1/comms?task_id=${String(taskId)}&limit=1&cursor=${String(firstPageBody.next_cursor)}`,
				headers: visibleHeaders,
			});
			expect(secondPage.json().items).toHaveLength(1);
			expect(secondPage.json().items[0].id).not.toBe(firstPageBody.items[0].id);
			const hidden = await server.inject({
				method: "GET",
				url: `/api/v1/comms?task_id=${String(taskId)}`,
				headers: {
					"x-dev-principal": JSON.stringify({
						kind: "human",
						id: "hidden",
						scopes: ["user:hidden"],
					}),
				},
			});
			expect(hidden.json().items).toEqual([]);
			expect(
				(
					await server.inject({
						method: "GET",
						url: "/api/v1/comms?type=nope",
						headers: visibleHeaders,
					})
				).statusCode,
			).toBe(400);
			expect(
				(
					await server.inject({
						method: "GET",
						url: "/api/v1/comms?cursor=123",
						headers: visibleHeaders,
					})
				).statusCode,
			).toBe(400);
		} finally {
			await server.close();
		}
	});
});

describe("staged update approval reversal", () => {
	it("records an approval, exposes it after reload, and revokes it only before apply", async () => {
		const suffix = randomBytes(5).toString("hex");
		const principalId = `updates-operator-${suffix}`;
		const boxId = `box-${suffix}`;
		await services.db.admin`insert into grants (subject, relation, object, granted_by)
			values (${principalId}, 'operator', 'fleet', 'test')`;
		const status = await services.emit(
			"bridge:hosts",
			emission({
				type: "box.update_status_changed",
				source: { service: "bridge", host: ".14", agent: null },
				subject: boxId,
				subject_kind: "host",
				dimensions: {
					box_id: boxId,
					hostname: ".14",
					source_tool: "apt",
					agent_vs_agentless: "agent",
					status: "updates_pending",
					apply_mode: "staged-approval",
				},
				measures: { pending_updates_count: 2, security_critical_count: 1 },
				meta: {
					box_update_raw: {
						box_id: boxId,
						packages: ["openssl", "curl", "linux-image"].map((name) => ({
							name,
							from: "1",
							to: "2",
							security: name === "openssl",
						})),
						vulns: [],
						collected_at: new Date().toISOString(),
					},
				},
			}),
			900,
		);
		expect(status.ok).toBe(true);
		await waitProjected("box_update", boxId, status.seq as number);

		const server = await buildServer(services, true);
		const headers = {
			"content-type": "application/json",
			"x-dev-principal": JSON.stringify({
				kind: "human",
				id: principalId,
				tiers: [],
				lanes: ["viewer", "operator"],
				scopes: ["fleet"],
			}),
		};
		try {
			const approveId = randomUUID();
			const approved = await server.inject({
				method: "POST",
				url: "/api/v1/op",
				headers,
				payload: {
					schema_version: 1,
					id: approveId,
					op: "updates.approve",
					args: { box_id: boxId, packages: ["openssl", "curl"] },
					dry_run: false,
				},
			});
			expect(
				approved.statusCode,
				`${approved.body} ${capturedServiceExceptions.at(-1)?.message ?? ""}`,
			).toBe(200);
			expect(approved.json()).toMatchObject({
				ok: true,
				result: { approval_id: approveId, box_id: boxId },
				undo: { op: "updates.revoke", args: { approval_id: approveId } },
			});
			for (const [packages, code] of [
				[["openssl"], "approval_already_pending"],
				[["not-a-real-package"], "approval_package_stale"],
			] as const) {
				const rejected = await server.inject({
					method: "POST",
					url: "/api/v1/op",
					headers,
					payload: {
						schema_version: 1,
						id: randomUUID(),
						op: "updates.approve",
						args: { box_id: boxId, packages },
						dry_run: false,
					},
				});
				expect(rejected.statusCode).toBe(400);
				expect(rejected.json().error.code).toBe(code);
			}

			const listed = await server.inject({
				method: "GET",
				url: `/api/v1/update-approvals?box_id=${boxId}`,
				headers,
			});
			expect(listed.statusCode, listed.body).toBe(200);
			expect(listed.json().items).toEqual([
				expect.objectContaining({
					approval_id: approveId,
					box_id: boxId,
					packages: ["openssl", "curl"],
					approved_by: principalId,
					observed_at: expect.any(String),
				}),
			]);
			const approvalSchema = JSON.parse(
				readFileSync(
					new URL(
						"../docs/contracts/schemas/entities/update-approval.schema.json",
						import.meta.url,
					),
					"utf8",
				),
			) as Record<string, unknown>;
			expect(validateJsonSchema(listed.json().items[0], approvalSchema, "approval")).toBeNull();

			const revoked = await server.inject({
				method: "POST",
				url: "/api/v1/op",
				headers,
				payload: {
					schema_version: 1,
					id: randomUUID(),
					op: "updates.revoke",
					args: { approval_id: approveId },
					dry_run: false,
				},
			});
			expect(revoked.statusCode, revoked.body).toBe(200);
			expect(revoked.json()).toMatchObject({
				ok: true,
				result: { approval_id: approveId, box_id: boxId },
			});
			const after = await server.inject({
				method: "GET",
				url: `/api/v1/update-approvals?box_id=${boxId}`,
				headers,
			});
			expect(after.json().items).toEqual([]);

			const repeated = await server.inject({
				method: "POST",
				url: "/api/v1/op",
				headers,
				payload: {
					schema_version: 1,
					id: randomUUID(),
					op: "updates.revoke",
					args: { approval_id: approveId },
					dry_run: false,
				},
			});
			expect(repeated.statusCode).toBe(400);
			expect(repeated.json().error.code).toBe("approval_not_pending");

			const approvalPayload = () => ({
				schema_version: 1,
				id: randomUUID(),
				op: "updates.approve",
				args: { box_id: boxId, packages: ["linux-image"] },
				dry_run: false,
			});
			const concurrentApprovals = await Promise.all([
				server.inject({ method: "POST", url: "/api/v1/op", headers, payload: approvalPayload() }),
				server.inject({ method: "POST", url: "/api/v1/op", headers, payload: approvalPayload() }),
			]);
			expect(concurrentApprovals.map((response) => response.statusCode).sort()).toEqual([200, 400]);
			const concurrentApprovalId = concurrentApprovals
				.find((response) => response.statusCode === 200)
				?.json().result.approval_id as string;
			const revokePayload = () => ({
				schema_version: 1,
				id: randomUUID(),
				op: "updates.revoke",
				args: { approval_id: concurrentApprovalId },
				dry_run: false,
			});
			const concurrentRevokes = await Promise.all([
				server.inject({ method: "POST", url: "/api/v1/op", headers, payload: revokePayload() }),
				server.inject({ method: "POST", url: "/api/v1/op", headers, payload: revokePayload() }),
			]);
			expect(concurrentRevokes.map((response) => response.statusCode).sort()).toEqual([200, 400]);

			const appliedApprovalId = randomUUID();
			const appliedApproval = await server.inject({
				method: "POST",
				url: "/api/v1/op",
				headers,
				payload: {
					schema_version: 1,
					id: appliedApprovalId,
					op: "updates.approve",
					args: { box_id: boxId, packages: ["openssl"] },
					dry_run: false,
				},
			});
			expect(appliedApproval.statusCode, appliedApproval.body).toBe(200);
			const appliedStatus = await services.emit(
				"bridge:hosts",
				emission({
					type: "box.update_status_changed",
					source: { service: "bridge", host: ".14", agent: null },
					subject: boxId,
					subject_kind: "host",
					dimensions: {
						box_id: boxId,
						hostname: ".14",
						source_tool: "apt",
						agent_vs_agentless: "agent",
						status: "updates_pending",
						apply_mode: "staged-approval",
					},
					measures: { pending_updates_count: 1, security_critical_count: 0 },
					meta: {
						box_update_raw: {
							box_id: boxId,
							packages: [{ name: "curl", from: "1", to: "2", security: false }],
							vulns: [],
							collected_at: new Date().toISOString(),
						},
					},
				}),
				900,
			);
			expect(appliedStatus.ok).toBe(true);
			const appliedRevoke = await server.inject({
				method: "POST",
				url: "/api/v1/op",
				headers,
				payload: {
					schema_version: 1,
					id: randomUUID(),
					op: "updates.revoke",
					args: { approval_id: appliedApprovalId },
					dry_run: false,
				},
			});
			expect(appliedRevoke.statusCode).toBe(400);
			expect(appliedRevoke.json().error.code).toBe("approval_not_pending");
		} finally {
			await server.close();
		}
	});
});

describe("terminal server gate and frame transport (BR-014)", () => {
	const principal = {
		kind: "human",
		id: "terminal-owner",
		tiers: ["owner"],
		lanes: ["viewer", "editor", "operator", "admin", "term_admin"],
		scopes: ["fleet"],
	};
	const headers = {
		"content-type": "application/json",
		"x-dev-principal": JSON.stringify(principal),
	};
	const adapter: TerminalAdapter = {
		async health() {
			return true;
		},
		async capture() {
			return Buffer.from("ready\n$ ");
		},
		async input() {},
	};

	it("returns 403 only after retaining a non-admin deep-link denial", async () => {
		const server = await buildServer(services, true, undefined, adapter);
		const deniedId = `terminal-viewer-${randomBytes(5).toString("hex")}`;
		try {
			const response = await server.inject({
				method: "GET",
				url: "/api/v1/terminal",
				headers: {
					"x-dev-principal": JSON.stringify({
						kind: "human",
						id: deniedId,
						tiers: [],
						lanes: ["viewer"],
						scopes: [],
					}),
				},
			});
			expect(response.statusCode).toBe(403);
			expect(response.json().error.code).toBe("term_denied");
			const retained = await services.db.admin<{ seq: string }[]>`
				select seq from events
				where type = 'term.denied' and dimensions->>'principal' = ${deniedId}`;
			expect(retained).toHaveLength(1);
		} finally {
			await server.close();
		}
	});

	it("commits watch audit before the first PTY capture/frame and audits attached input", async () => {
		let auditWasVisibleAtCapture = false;
		const inputs: Buffer[] = [];
		const orderedAdapter: TerminalAdapter = {
			async health() {
				return true;
			},
			async capture() {
				const rows = await services.db.admin`
					select 1 from events
					where type = 'term.watch' and dimensions->>'principal' = ${principal.id}`;
				auditWasVisibleAtCapture = rows.length > 0;
				return Buffer.from("first audited frame\n$ ");
			},
			async input(_target, data) {
				inputs.push(data);
			},
		};
		const server = await buildServer(services, true, undefined, orderedAdapter);
		const origin = await server.listen({ host: "127.0.0.1", port: 0 });
		const controller = new AbortController();
		try {
			const response = await fetch(`${origin}/api/v1/terminal/streams`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					host: ".14",
					tmux_session: "agents",
					pane_id: "%12",
					scrollback_lines: 500,
				}),
				signal: controller.signal,
			});
			expect(response.status).toBe(200);
			const reader = response.body?.getReader();
			expect(reader).toBeDefined();
			let wire = "";
			while (wire.split("\n").filter(Boolean).length < 2) {
				const frame = await reader!.read();
				wire += new TextDecoder().decode(frame.value);
			}
			const frames = wire
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(frames[0]).toMatchObject({ kind: "open", seq: 0, mode: "read" });
			expect(typeof frames[0]?.["audit_seq"]).toBe("number");
			expect(frames[1]).toMatchObject({ kind: "snapshot", seq: 1 });
			expect(auditWasVisibleAtCapture).toBe(true);
			const streamId = String(frames[0]?.["stream_id"]);

			const attach = await fetch(`${origin}/api/v1/terminal/streams/${streamId}/attach`, {
				method: "POST",
				headers,
				body: "{}",
			});
			expect(attach.status).toBe(200);
			const input = await fetch(`${origin}/api/v1/terminal/streams/${streamId}/input`, {
				method: "POST",
				headers,
				body: JSON.stringify({ data_b64: Buffer.from("x").toString("base64") }),
			});
			expect(input.status).toBe(200);
			expect(inputs).toEqual([Buffer.from("x")]);
			const inputAudit = await services.db.admin`
				select 1 from events
				where type = 'term.input' and dimensions->>'stream_id' = ${streamId}`;
			expect(inputAudit).toHaveLength(1);

			const detach = await fetch(`${origin}/api/v1/terminal/streams/${streamId}/detach`, {
				method: "POST",
				headers,
				body: "{}",
			});
			expect(detach.status).toBe(200);
		} finally {
			controller.abort();
			await server.close();
		}
	}, 30_000);

	it("opens and polls an audited read-only peek session", async () => {
		await services.db.writer`
			insert into current_state (kind, subject, scope, state, observed_at, seq)
			values ('heartbeat', 'terminal-peek-agent', 'fleet',
				${services.db.writer.json({ host: ".14", handle: "terminal-peek-agent", tmux_session: "agents", pane_id: "%12" })},
				now(), 990014)
			on conflict (kind, subject) do update set state = excluded.state,
				observed_at = excluded.observed_at, seq = excluded.seq`;
		let auditWasVisibleAtCapture = false;
		let captures = 0;
		const peekAdapter: TerminalAdapter = {
			async health() {
				return true;
			},
			async capture() {
				captures += 1;
				const rows = await services.db.admin`
					select 1 from events
					where type = 'term.watch' and dimensions->>'principal' = ${principal.id}`;
				auditWasVisibleAtCapture = rows.length > 0;
				return Buffer.from(`peek ${String(captures)}`);
			},
			async input() {
				throw new Error("peek must not expose input");
			},
		};
		const server = await buildServer(services, true, undefined, peekAdapter);
		try {
			const opened = await server.inject({
				method: "POST",
				url: "/api/v1/terminal/peek",
				headers,
				payload: { host: ".14", tmux_session: "agents", pane_id: "%12", scrollback_lines: 500 },
			});
			expect(opened.statusCode).toBe(200);
			expect(auditWasVisibleAtCapture).toBe(true);
			expect(Buffer.from(opened.json().data_b64, "base64").toString()).toBe("peek 1");
			const streamId = String(opened.json().stream_id);
			const polled = await server.inject({
				method: "GET",
				url: `/api/v1/terminal/peek/${streamId}`,
				headers,
			});
			expect(polled.statusCode).toBe(200);
			expect(polled.json()).toMatchObject({ stream_id: streamId, seq: 2 });
			expect(Buffer.from(polled.json().data_b64, "base64").toString()).toBe("peek 2");
			const attach = await server.inject({
				method: "POST",
				url: `/api/v1/terminal/streams/${streamId}/attach`,
				headers,
				payload: {},
			});
			expect(attach.statusCode).toBe(409);
			expect(attach.json().error.code).toBe("watch_only");
			const arbitrary = await server.inject({
				method: "POST",
				url: "/api/v1/terminal/peek",
				headers,
				payload: { host: "other.example", tmux_session: "agents", pane_id: "%12" },
			});
			expect(arbitrary.statusCode).toBe(404);
			expect(arbitrary.json().error.code).toBe("pane_not_visible");
		} finally {
			await server.close();
		}
	});
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

	it("sanitizes appender exceptions for emitters and reports bounded incident metadata", async () => {
		capturedServiceExceptions.length = 0;
		internalServiceErrors.length = 0;
		const originalAppend = services.appender.append.bind(services.appender);
		services.appender.append = async () => {
			throw new Error("private database host=db.internal relation=events");
		};
		const server = await buildServer(services, true);
		try {
			const response = await server.inject({
				method: "POST",
				url: "/api/v1/emit",
				headers: {
					"x-dev-principal": JSON.stringify({
						kind: "system",
						id: "test:emitter",
						scopes: ["fleet"],
						lanes: [],
					}),
				},
				payload: emission(),
			});
			expect(response.statusCode).toBe(503);
			expect(response.json()).toEqual({
				error: {
					code: "append_failed",
					message: "emission append failed",
					retryable: true,
				},
			});
			expect(response.body).not.toContain("db.internal");
			expect(capturedServiceExceptions).toHaveLength(1);
			expect(String(capturedServiceExceptions[0])).toMatch(
				/^Error: append failed; incident [0-9a-f-]{36}$/,
			);
			expect(String(capturedServiceExceptions[0])).not.toContain("db.internal");
			expect(internalServiceErrors).toHaveLength(1);
			const incident = JSON.parse(internalServiceErrors[0] ?? "{}");
			expect(incident).toMatchObject({
				level: "error",
				service: "console-api",
				event: "append_failed",
				error_class: "Error",
			});
			expect(incident.incident_id).toMatch(/^[0-9a-f-]{36}$/);
			expect(internalServiceErrors[0]).not.toContain("db.internal");
		} finally {
			services.appender.append = originalAppend;
			await server.close();
		}
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

describe("Better Auth browser boundary", () => {
	const consoleOrigin = "https://console.petalcat.dev";
	const betterAuth: BetterAuthSessionVerifier = {
		consoleOrigin,
		async getIdentity(headers) {
			return String(headers.cookie ?? "").includes("__Host-console.session_token=valid-session")
				? {
						username: "parker",
						groups: ["authentik Admins"],
						subject: "authentik-parker",
						sessionId: "valid-session",
					}
				: null;
		},
		async getIdentityBySessionId(sessionId) {
			return sessionId === "valid-session"
				? {
						username: "parker",
						groups: ["authentik Admins"],
						subject: "authentik-parker",
						sessionId,
					}
				: null;
		},
		async close() {},
	};

	it("accepts only a valid Better Auth session and maps current ReBAC grants", async () => {
		const server = await buildServer(services, false, undefined, undefined, betterAuth);
		try {
			const spoofed = await server.inject({
				method: "GET",
				url: "/api/v1/me",
				headers: {
					"x-authentik-username": "parker",
					"x-authentik-groups": "owner",
				},
			});
			expect(spoofed.statusCode).toBe(401);

			const authenticated = await server.inject({
				method: "GET",
				url: "/api/v1/me",
				headers: {
					origin: consoleOrigin,
					cookie: "__Host-console.session_token=valid-session",
				},
			});
			expect(authenticated.statusCode, authenticated.body).toBe(200);
			expect(authenticated.headers["access-control-allow-origin"]).toBe(consoleOrigin);
			expect(authenticated.json()).toMatchObject({
				kind: "human",
				id: "parker",
				tiers: ["owner"],
				lanes: ["viewer", "editor", "operator", "admin"],
				scopes: ["fleet", "user:parker"],
			});
		} finally {
			await server.close();
		}
	});

	it.each(["owner", "moderator", "collaborator", "guest", "authentik admins", "admin "])(
		"does not inherit a console tier from the non-admin Authentik group %s",
		async (group) => {
			const nonAdminVerifier: BetterAuthSessionVerifier = {
				...betterAuth,
				async getIdentity() {
					return {
						username: "parker",
						groups: [group],
						subject: "authentik-parker",
						sessionId: "valid-session",
					};
				},
			};
			const server = await buildServer(services, false, undefined, undefined, nonAdminVerifier);
			try {
				const response = await server.inject({
					method: "GET",
					url: "/api/v1/me",
					headers: { origin: consoleOrigin, cookie: "__Host-console.session_token=valid-session" },
				});
				expect(response.statusCode).toBe(401);
			} finally {
				await server.close();
			}
		},
	);

	it("maps the exact admin group alias to the owner tier", async () => {
		const adminAliasVerifier: BetterAuthSessionVerifier = {
			...betterAuth,
			async getIdentity() {
				return {
					username: "parker",
					groups: ["admin", "owner", "moderator"],
					subject: "authentik-parker",
					sessionId: "valid-session",
				};
			},
		};
		const server = await buildServer(services, false, undefined, undefined, adminAliasVerifier);
		try {
			const response = await server.inject({
				method: "GET",
				url: "/api/v1/me",
				headers: { origin: consoleOrigin, cookie: "__Host-console.session_token=valid-session" },
			});
			expect(response.statusCode, response.body).toBe(200);
			expect(response.json().tiers).toEqual(["owner"]);
		} finally {
			await server.close();
		}
	});

	it("rejects cross-origin requests even with a valid session", async () => {
		const server = await buildServer(services, false, undefined, undefined, betterAuth);
		try {
			const response = await server.inject({
				method: "GET",
				url: "/api/v1/me",
				headers: {
					origin: "https://evil.example",
					cookie: "__Host-console.session_token=valid-session",
				},
			});
			expect(response.statusCode).toBe(403);
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

describe("Phase 3 ReBAC control plane", () => {
	it("grants and revokes item visibility through the owner-gated idempotent API", async () => {
		const itemId = `dash_${randomBytes(12).toString("hex")}`;
		const object = `item:${itemId}`;
		await services.db.writer`
			insert into items_min (id, kind, title, scope, created_by, payload)
			values (${itemId}, 'artifact', 'Shared investigation', 'fleet', 'parker', ${services.db.writer.json(
				{
					schema_version: 1,
					layout: {},
					panels: [{ schema_version: 2, type: "text", title: "Shared", prose: "Scoped shell" }],
					query_refs: [],
					branch: null,
					time: null,
				},
			)})`;
		const token = `phase3_${randomBytes(18).toString("base64url")}`;
		await services.db.admin`insert into api_tokens (token_sha256, subject, kind, tiers, lanes)
			values (${sha256(token)}, 'rebac-viewer', 'human', '[]', '["viewer"]')`;
		const ownerHeaders = {
			"x-dev-principal": JSON.stringify({
				kind: "human",
				id: "parker",
				tiers: [],
				lanes: ["admin"],
				scopes: ["fleet"],
			}),
		};
		const server = await buildServer(services, true);
		try {
			const before = await resolveBearer(services.db.admin, token);
			expect(before?.scopes).not.toContain(object);
			const invalidWindow = await server.inject({
				method: "POST",
				url: "/api/v1/grants",
				headers: ownerHeaders,
				payload: {
					schema_version: 1,
					id: randomUUID(),
					action: "grant",
					subject: "rebac-viewer",
					relation: "viewer",
					object,
					invalid_at: "2020-01-01T00:00:00.000Z",
				},
			});
			expect(invalidWindow.statusCode).toBe(400);
			await expect(
				services.db.admin`insert into grants
					(subject, relation, object, valid_at, invalid_at, granted_by)
					values ('invalid-window', 'viewer', 'fleet', now(), now() - interval '1 second', 'test')`,
			).rejects.toThrow(/grants_valid_window|check constraint/);
			let resolveNotification!: (zookie: string) => void;
			const notified = new Promise<string>((resolve) => {
				resolveNotification = resolve;
			});
			const stopWatching = services.onGrantChange(resolveNotification);
			const requestId = randomUUID();
			const body = {
				schema_version: 1,
				id: requestId,
				action: "grant",
				subject: "rebac-viewer",
				relation: "viewer",
				object,
			};
			const granted = await server.inject({
				method: "POST",
				url: "/api/v1/grants",
				headers: ownerHeaders,
				payload: body,
			});
			expect(granted.statusCode, granted.body).toBe(200);
			expect(granted.json()).toMatchObject({
				action: "granted",
				grant: { object, zookie: expect.any(String) },
			});
			expect(
				await Promise.race([
					notified,
					new Promise<never>((_resolve, reject) =>
						setTimeout(() => reject(new Error("grant notification timed out")), 2_000),
					),
				]),
			).toBe(granted.json().grant.zookie);
			stopWatching();
			const retry = await server.inject({
				method: "POST",
				url: "/api/v1/grants",
				headers: ownerHeaders,
				payload: body,
			});
			expect(retry.json()).toEqual(granted.json());
			const drift = await server.inject({
				method: "POST",
				url: "/api/v1/grants",
				headers: ownerHeaders,
				payload: { ...body, relation: "editor" },
			});
			expect(drift.statusCode).toBe(409);
			expect(drift.json().error.code).toBe("id_reused");

			const visible = await server.inject({
				method: "GET",
				url: `/api/v1/dashboards/${itemId}`,
				headers: { authorization: `Bearer ${token}` },
			});
			expect(visible.statusCode, visible.body).toBe(200);
			const listed = await server.inject({
				method: "GET",
				url: `/api/v1/grants?object=${encodeURIComponent(object)}`,
				headers: ownerHeaders,
			});
			expect(listed.json()).toMatchObject({
				object,
				zookie: expect.any(String),
				items: [{ subject: "rebac-viewer" }],
			});
			const deniedList = await server.inject({
				method: "GET",
				url: `/api/v1/grants?object=${encodeURIComponent(object)}`,
				headers: { authorization: `Bearer ${token}` },
			});
			expect(deniedList.statusCode).toBe(403);

			const revoked = await server.inject({
				method: "POST",
				url: "/api/v1/grants",
				headers: ownerHeaders,
				payload: {
					schema_version: 1,
					id: randomUUID(),
					action: "revoke",
					subject: "rebac-viewer",
					relation: "viewer",
					object,
				},
			});
			expect(revoked.json()).toMatchObject({
				action: "revoked",
				revoked_count: 1,
				zookie: expect.any(String),
			});
			const hidden = await server.inject({
				method: "GET",
				url: `/api/v1/dashboards/${itemId}`,
				headers: { authorization: `Bearer ${token}` },
			});
			expect(hidden.statusCode).toBe(404);
			const after = await resolveBearer(services.db.admin, token);
			expect(BigInt(after!.zookie)).toBeGreaterThan(BigInt(before!.zookie));
			await Promise.all(
				["a", "b", "c", "d"].map(
					(suffix) => services.db.admin`
						insert into grants (subject, relation, object, granted_by)
						values (${`parallel-${suffix}`}, 'viewer', ${`restricted:parallel-${suffix}`}, 'test')`,
				),
			);
			const fence = await services.db.admin<{ head: string; row_max: string }[]>`
				select s.zookie::text as head, max(g.zookie)::text as row_max
				from grant_set_state s cross join grants g where s.singleton group by s.zookie`;
			expect(fence[0]?.head).toBe(fence[0]?.row_max);
		} finally {
			await server.close();
		}
	});

	it("gives agents only their intrinsic private scope and requires editor grants to emit elsewhere", async () => {
		const agent = `agent:test-${randomBytes(4).toString("hex")}`;
		const token = `phase3_${randomBytes(18).toString("base64url")}`;
		await services.db.admin`insert into api_tokens (token_sha256, subject, kind, tiers, lanes)
			values (${sha256(token)}, ${agent}, 'agent', '[]', '["viewer"]')`;
		await services.db.admin`insert into producer_registrations
			(subject, allowed_services, allowed_prefixes, allowed_scopes, max_severity)
			values (${agent}, '["bridge"]', '["test"]', '["agent:*"]', 'warn')`;
		const principal = await resolveBearer(services.db.admin, token);
		expect(principal?.scopes).toEqual([agent]);
		const server = await buildServer(services, true);
		try {
			const deniedWrite = await server.inject({
				method: "POST",
				url: "/api/v1/dashboards",
				headers: { authorization: `Bearer ${token}` },
				payload: {
					schema_version: 1,
					id: randomUUID(),
					title: "No implicit write",
					scope: agent,
					panels: [{ schema_version: 2, type: "text", title: "Private", prose: "Private" }],
				},
			});
			expect(deniedWrite.statusCode).toBe(403);
			const ownerOnly = await server.inject({
				method: "GET",
				url: `/api/v1/grants?object=${encodeURIComponent(agent)}`,
				headers: { authorization: `Bearer ${token}` },
			});
			expect(ownerOnly.statusCode).toBe(403);
		} finally {
			await server.close();
		}
		await expect(services.db.app`select subject from grants limit 1`).rejects.toThrow(
			/permission denied/,
		);
		expect(
			await services.emit(
				principal!,
				emission({
					type: "test.agent_private",
					source: { service: "bridge", host: null, agent: agent.slice(6) },
					scope: agent,
				}),
				300,
			),
		).toMatchObject({ ok: true });
		expect(
			await services.emit(
				principal!,
				emission({
					type: "test.agent_private",
					source: { service: "bridge", host: null, agent: agent.slice(6) },
					scope: "fleet",
				}),
				300,
			),
		).toMatchObject({ ok: false, code: "scope_denied" });
	});
});

describe("Phase 4 permission levels", () => {
	it("resolves commit versus propose posture in named-op preflight without tier-name checks", async () => {
		expect(resolvedOpCapabilities("task.update", "human", true)).toEqual({ force: false });
		expect(resolvedOpCapabilities("task.update", "human", false)).toEqual({ force: true });
		expect(resolvedOpCapabilities("task.update", "agent", false)).toEqual({ force: false });
		await services.db.admin`
			insert into tiers (name, authentik_group, description, default_relations, propose_only)
			values ('custom_operator', 'custom-operators', 'Custom data-driven operator.', '["operator"]', true)`;
		await services.db.admin`
			insert into grants (subject, relation, object, granted_by)
			values ('tier:custom_operator', 'operator', 'fleet', 'test')`;
		const principal = {
			kind: "human",
			id: "custom-operator",
			tiers: ["custom_operator"],
			lanes: ["viewer", "editor", "operator"],
			scopes: [],
		};
		const server = await buildServer(services, true);
		const taskPreflight = (force: boolean) =>
			server.inject({
				method: "POST",
				url: "/api/v1/op",
				headers: { "x-dev-principal": JSON.stringify(principal) },
				payload: {
					schema_version: 1,
					op: "task.update",
					id: randomUUID(),
					args: { id: 42, patch: { status: "review" }, force },
					dry_run: true,
				},
			});
		const preflight = () =>
			server.inject({
				method: "POST",
				url: "/api/v1/op",
				headers: { "x-dev-principal": JSON.stringify(principal) },
				payload: {
					schema_version: 1,
					op: "signal.snooze",
					id: randomUUID(),
					args: { type_pattern: "task.**", duration_s: 3600 },
					dry_run: true,
				},
			});
		try {
			const deniedForce = await taskPreflight(true);
			expect(deniedForce.statusCode, deniedForce.body).toBe(403);
			expect(deniedForce.json().error).toMatchObject({ code: "force_denied" });
			const proposalPath = await taskPreflight(false);
			expect(proposalPath.statusCode, proposalPath.body).toBe(503);
			expect(proposalPath.json().error).toMatchObject({ code: "executor_unreachable" });

			const proposed = await preflight();
			expect(proposed.statusCode, proposed.body).toBe(200);
			expect(proposed.json().result).toMatchObject({ dry_run: true, effect: "propose" });

			await services.db.admin`
				insert into grants (subject, relation, object, granted_by)
				values ('custom-operator', 'operator', 'user:custom-operator', 'test')`;
			const committed = await preflight();
			expect(committed.statusCode, committed.body).toBe(200);
			expect(committed.json().result).toMatchObject({ dry_run: true, effect: "commit" });
		} finally {
			await server.close();
		}
	});

	it("publishes seeded and inserted permission levels through the authenticated catalog", async () => {
		await services.db.admin`
			insert into tiers (name, authentik_group, description, default_relations, propose_only)
			values ('reviewer', 'reviewers', 'Can review explicitly shared work.', '["viewer"]', true)`;
		const server = await buildServer(services, true);
		try {
			const response = await server.inject({
				method: "GET",
				url: "/api/v1/tiers",
				headers: {
					"x-dev-principal": JSON.stringify({
						kind: "human",
						id: "tier-reader",
						tiers: ["guest"],
						lanes: ["viewer"],
						scopes: [],
					}),
				},
			});
			expect(response.statusCode, response.body).toBe(200);
			const catalog = response.json();
			expect(catalog.schema_version).toBe(1);
			expect(catalog.items).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						name: "collaborator",
						description: expect.any(String),
						default_relations: ["viewer"],
						propose_only: true,
					}),
					{
						name: "reviewer",
						authentik_group: "reviewers",
						description: "Can review explicitly shared work.",
						default_relations: ["viewer"],
						propose_only: true,
					},
				]),
			);
			await services.db.admin`
				update tiers set description = 'Locally configured owner.', default_relations = '["operator"]'
				where name = 'owner'`;
			await seedBootstrap(services.db.admin);
			const configured = await services.db.admin<
				{ description: string; default_relations: string[] }[]
			>`select description, default_relations from tiers where name = 'owner'`;
			expect(configured[0]).toEqual({
				description: "Locally configured owner.",
				default_relations: ["operator"],
			});
		} finally {
			await server.close();
		}
	});

	it("files a collaborator mutation in the real tracker RPC and never commits it locally", async () => {
		const trackerCalls: unknown[] = [];
		const reconciledTasks = new Map<string, number>();
		const tracker = createHttpServer((request, response) => {
			let body = "";
			request.setEncoding("utf8");
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", () => {
				const parsedBody = JSON.parse(body) as {
					args?: { title?: string; body?: string };
				};
				trackerCalls.push({
					authorization: request.headers.authorization,
					body: parsedBody,
				});
				if (parsedBody.args?.body?.includes('"title": "Ambiguous response"')) {
					const match = /"request_id": "([^"]+)"/.exec(parsedBody.args.body ?? "");
					if (match?.[1]) reconciledTasks.set(match[1], 9001);
					response.destroy();
					return;
				}
				response.writeHead(201, { "content-type": "application/json" });
				response.end(JSON.stringify({ filed: { id: 8123 } }));
			});
		});
		await new Promise<void>((resolve) => tracker.listen(0, "127.0.0.1", resolve));
		const address = tracker.address();
		if (!address || typeof address === "string")
			throw new Error("tracker test server did not bind");
		const writer = new TrackerProposalWriter({
			url: `http://127.0.0.1:${String(address.port)}/api/agent/rpc`,
			token: "tracker-test-token",
			project: "Lab Console",
		});
		const trackerProposalLookup = {
			findProposalTaskId(criteria: {
				requestId: string;
				principalId: string;
				operation: string;
				requestHash: string;
				project: string;
			}) {
				if (
					criteria.principalId !== "semi-trusted" ||
					criteria.operation !== "dashboard.save" ||
					criteria.project !== "Lab Console" ||
					!criteria.requestHash
				)
					return null;
				return reconciledTasks.get(criteria.requestId) ?? null;
			},
		};
		const server = await buildServer(
			{ ...services, trackerProposals: writer, trackerProposalLookup },
			true,
		);
		const requestId = randomUUID();
		const payload = {
			schema_version: 1,
			id: requestId,
			title: "Collaborator suggestion",
			scope: "fleet",
			panels: [{ schema_version: 2, type: "text", title: "Idea", prose: "Please consider this." }],
		};
		const headers = {
			"x-dev-principal": JSON.stringify({
				kind: "human",
				id: "semi-trusted",
				tiers: ["collaborator"],
				lanes: ["viewer"],
				scopes: ["fleet"],
			}),
		};
		try {
			const proposed = await server.inject({
				method: "POST",
				url: "/api/v1/dashboards",
				headers,
				payload,
			});
			expect(proposed.statusCode, proposed.body).toBe(200);
			expect(proposed.json()).toEqual({
				schema_version: 1,
				in_reply_to: requestId,
				ok: true,
				status: "applied",
				result: { proposed: true, proposal_task_id: 8123 },
			});
			const retried = await server.inject({
				method: "POST",
				url: "/api/v1/dashboards",
				headers,
				payload,
			});
			expect(retried.json()).toEqual(proposed.json());
			expect(trackerCalls).toHaveLength(1);
			expect(trackerCalls[0]).toMatchObject({
				authorization: "Bearer tracker-test-token",
				body: {
					op: "file",
					args: {
						kind: "idea",
						project: "Lab Console",
						title: "[Proposal] dashboard.save",
					},
				},
			});
			const grantProposal = await server.inject({
				method: "POST",
				url: "/api/v1/grants",
				headers,
				payload: {
					schema_version: 1,
					id: randomUUID(),
					action: "grant",
					subject: "would-be-viewer",
					relation: "viewer",
					object: "fleet",
				},
			});
			expect(grantProposal.statusCode, grantProposal.body).toBe(200);
			expect(grantProposal.json().result).toEqual({
				proposed: true,
				proposal_task_id: 8123,
			});
			expect(trackerCalls).toHaveLength(2);
			expect(trackerCalls[1]).toMatchObject({
				body: { op: "file", args: { title: "[Proposal] grant.mutate" } },
			});
			await services.db.admin`
				insert into tiers (name, authentik_group, description, default_relations, propose_only)
				values ('viewer_commit', 'viewer-commit', 'Tie test.', '["viewer"]', false)`;
			const tied = await server.inject({
				method: "POST",
				url: "/api/v1/dashboards",
				headers: {
					"x-dev-principal": JSON.stringify({
						kind: "human",
						id: "tied-collaborator",
						tiers: ["collaborator", "viewer_commit"],
						lanes: ["viewer"],
						scopes: ["fleet"],
					}),
				},
				payload: { ...payload, id: randomUUID(), title: "Restrictive tie wins" },
			});
			expect(tied.statusCode, tied.body).toBe(200);
			expect(tied.json().result.proposed).toBe(true);
			expect(trackerCalls).toHaveLength(3);

			const ambiguousId = randomUUID();
			const ambiguous = await server.inject({
				method: "POST",
				url: "/api/v1/dashboards",
				headers,
				payload: { ...payload, id: ambiguousId, title: "Ambiguous response" },
			});
			expect(ambiguous.statusCode, ambiguous.body).toBe(200);
			expect(ambiguous.json().result.proposal_task_id).toBe(9001);
			const ambiguousRetry = await server.inject({
				method: "POST",
				url: "/api/v1/dashboards",
				headers,
				payload: { ...payload, id: ambiguousId, title: "Ambiguous response" },
			});
			expect(ambiguousRetry.json()).toEqual(ambiguous.json());
			expect(trackerCalls).toHaveLength(4);
			const crossPrincipal = await server.inject({
				method: "POST",
				url: "/api/v1/dashboards",
				headers: {
					"x-dev-principal": JSON.stringify({
						kind: "human",
						id: "different-collaborator",
						tiers: ["collaborator"],
						lanes: ["viewer"],
						scopes: ["fleet"],
					}),
				},
				payload: { ...payload, id: ambiguousId, title: "Different principal" },
			});
			expect(crossPrincipal.statusCode, crossPrincipal.body).toBe(200);
			expect(crossPrincipal.json().result.proposal_task_id).toBe(8123);
			expect(trackerCalls).toHaveLength(5);
			const secret = await server.inject({
				method: "POST",
				url: "/api/v1/dashboards",
				headers,
				payload: {
					...payload,
					id: randomUUID(),
					panels: [
						{ schema_version: 2, type: "text", title: "Unsafe", prose: "Bearer hidden-token" },
					],
				},
			});
			expect(secret.statusCode).toBe(400);
			expect(secret.json().error.code).toBe("secret_detected");
			expect(trackerCalls).toHaveLength(5);
			const committed = await services.db.admin<{ n: number }[]>`
				select count(*)::int as n from items_min
				where created_by = 'semi-trusted' and title = 'Collaborator suggestion'`;
			expect(committed[0]?.n).toBe(0);
			const committedGrant = await services.db.admin<{ n: number }[]>`
				select count(*)::int as n from grants
				where subject = 'would-be-viewer' and object = 'fleet'`;
			expect(committedGrant[0]?.n).toBe(0);
			const drift = await server.inject({
				method: "POST",
				url: "/api/v1/dashboards",
				headers,
				payload: { ...payload, title: "Changed after retry" },
			});
			expect(drift.statusCode).toBe(409);
			expect(drift.json().error.code).toBe("id_reused");
		} finally {
			await server.close();
			await new Promise<void>((resolve, reject) =>
				tracker.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});

	it("fails closed when proposals are unavailable and lets an explicit resource grant commit", async () => {
		const collaborator = {
			kind: "human" as const,
			id: "elevated-collaborator",
			tiers: ["collaborator"],
			lanes: ["viewer"],
			scopes: ["fleet"],
		};
		const headers = { "x-dev-principal": JSON.stringify(collaborator) };
		const payload = {
			schema_version: 1,
			id: randomUUID(),
			title: "Explicitly elevated",
			panels: [{ schema_version: 2, type: "text", title: "Elevated", prose: "Commit me." }],
		};
		const unavailable = await buildServer({ ...services, trackerProposals: null }, true);
		try {
			const hidden = await unavailable.inject({
				method: "POST",
				url: "/api/v1/dashboards",
				headers: {
					"x-dev-principal": JSON.stringify({ ...collaborator, scopes: [] }),
				},
				payload: { ...payload, scope: "restricted:victim" },
			});
			expect(hidden.statusCode).toBe(403);
			expect(hidden.json().error.code).toBe("scope_denied");
			const hiddenGrant = await unavailable.inject({
				method: "POST",
				url: "/api/v1/grants",
				headers: {
					"x-dev-principal": JSON.stringify({ ...collaborator, scopes: [] }),
				},
				payload: {
					schema_version: 1,
					id: randomUUID(),
					action: "grant",
					subject: "victim",
					relation: "viewer",
					object: "restricted:victim",
				},
			});
			expect(hiddenGrant.statusCode).toBe(403);
			expect(hiddenGrant.json().error.code).toBe("grant_denied");
			const refused = await unavailable.inject({
				method: "POST",
				url: "/api/v1/dashboards",
				headers,
				payload,
			});
			expect(refused.statusCode).toBe(503);
			expect(refused.json().error.code).toBe("tracker_unavailable");
		} finally {
			await unavailable.close();
		}
		await services.db.admin`
			insert into grants (subject, relation, object, granted_by)
			values ('elevated-collaborator', 'editor', 'fleet', 'test')`;
		const elevated = await buildServer({ ...services, trackerProposals: null }, true);
		try {
			const saved = await elevated.inject({
				method: "POST",
				url: "/api/v1/dashboards",
				headers,
				payload: { ...payload, id: randomUUID() },
			});
			expect(saved.statusCode, saved.body).toBe(200);
			expect(saved.json()).toMatchObject({ title: "Explicitly elevated", scope: "fleet" });
		} finally {
			await elevated.close();
		}
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
					cursorSecret: "test-cursor-secret",
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
				cursorSecret: "test-cursor-secret",
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
					cursorSecret: "test-cursor-secret",
					glitchtipDsn: null,
					trackerDbPath: null,
				},
				{ migrate: false },
			),
		).rejects.toThrow(/console_app|writer/);
	});

	it("keeps console_ro unable to mutate or create even after disabling its read-only default", async () => {
		const ro = postgres(temp.roUrl, { max: 1, onnotice: () => {} });
		try {
			await ro`set default_transaction_read_only = off`;
			await expect(
				ro`insert into events
					(id, type, ts, source_service, subject, severity, scope)
				 values (${randomUUID()}, 'test.ro_escape', now(), 'test', 'escape', 'info', 'fleet')`,
			).rejects.toThrow(/permission denied/);
			await expect(ro`create table public.console_ro_escape (id int)`).rejects.toThrow(
				/permission denied/,
			);
		} finally {
			await ro.end({ timeout: 2 });
		}
	});

	it("rejects console_ro membership in a privileged runtime role", async () => {
		await services.db.admin`grant console_writer to console_ro`;
		const db = openDb({
			databaseUrl: temp.adminUrl,
			appDatabaseUrl: temp.appUrl,
			roDatabaseUrl: temp.roUrl,
			writerDatabaseUrl: temp.writerUrl,
			host: "127.0.0.1",
			port: 0,
			devAuth: false,
			glitchtipDsn: null,
			trackerDbPath: null,
		});
		try {
			await expect(assertRuntimeRolesHardened(db, false)).rejects.toThrow(
				/membership|write\/create/,
			);
		} finally {
			await db.close();
			await services.db.admin`revoke console_writer from console_ro`;
		}
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
				"restart-replay-test",
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

	it("runs NL intent through scoped RAG, bounded self-heal, RO planning, and provenance", async () => {
		const type = `test.ask_${randomBytes(4).toString("hex")}`;
		await services.emit(
			"test:emitter",
			emission({
				type,
				dimensions: { zone: "north" },
				measures: { latency_ms: 12 },
				meta: { fields: { latency_ms: { kind: "gauge", unit: "ms" } } },
			}),
			400,
		);
		const calls: { feedback?: { code: string; message: string }; sources: string[] }[] = [];
		const compiler: AssistantCompiler = {
			async compile(input) {
				calls.push({
					...(input.feedback ? { feedback: input.feedback } : {}),
					sources: input.context.map(({ source_ref }) => source_ref),
				});
				const field = input.feedback ? "latency_ms" : "invented_measure";
				return {
					feasible: true,
					request: {
						schema_version: 1,
						mode: "structured",
						from: type,
						select: [{ field, agg: "avg", as: "latency" }],
						group_by: ["zone"],
						limit: 100,
					},
					panel: {
						type: "bar",
						title: "Latency by zone",
						encoding: { x: "zone", y: "latency" },
					},
				};
			},
		};
		const answer = await ask(
			{ app: services.db.app, ro: services.db.ro },
			compiler,
			["fleet"],
			"average latency by zone",
		);
		expect(answer.status).toBe("answered");
		expect(answer.attempts).toBe(2);
		expect(calls[0]?.sources).toContain(type);
		expect(calls[1]?.feedback).toMatchObject({ code: "bad_field" });
		expect(answer.result?.rows).toContainEqual(["north", 12]);
		expect(answer.panel).toMatchObject({ type: "bar", query_ref: answer.result?.query_ref });
		expect(answer.shown_sql?.sql).toContain("avg");
		expect(answer.shown_sql?.sql).not.toContain("invented_measure");
		expect(answer.answer).toContain("north");
		expect(
			await readQueryRecord(services.db.app, ["fleet"], answer.result?.query_ref ?? "missing"),
		).not.toBeNull();
	});

	it("self-heals once from a real execution type error without exposing database detail", async () => {
		const type = `test.ask_exec_${randomBytes(4).toString("hex")}`;
		const bad = emission({
			type,
			measures: { latency_ms: 12 },
			meta: { fields: { latency_ms: { kind: "gauge", unit: "ms" } } },
		});
		await services.emit("test:emitter", bad, 400);
		await services.db.admin`update events set measures = '{"latency_ms":"not-a-number"}'::jsonb
			where id = ${bad.id}`;
		const feedback: { code: string; message: string }[] = [];
		const compiler: AssistantCompiler = {
			async compile(input) {
				if (input.feedback) feedback.push(input.feedback);
				return {
					feasible: true,
					request: {
						schema_version: 1,
						mode: "structured",
						from: type,
						select: [
							input.feedback
								? { field: "latency_ms", agg: "count", as: "n" }
								: { field: "latency_ms", agg: "avg", as: "latency" },
						],
					},
					panel: { type: "stat", title: "Latency" },
				};
			},
		};
		const result = await ask(
			{ app: services.db.app, ro: services.db.ro },
			compiler,
			["fleet"],
			`average latency for ${type}`,
		);
		expect(result.status).toBe("answered");
		expect(result.attempts).toBe(2);
		expect(feedback).toEqual([
			{
				code: "execution_rejected",
				message: "structured execution rejected; revise fields or aggregation",
			},
		]);
		expect(JSON.stringify(feedback)).not.toContain("not-a-number");
	});

	it("returns an honest assistant refusal without calling a model when no scope is visible", async () => {
		let called = false;
		const compiler: AssistantCompiler = {
			async compile() {
				called = true;
				return { feasible: false, reason: "not visible" };
			},
		};
		const result = await ask(
			{ app: services.db.app, ro: services.db.ro },
			compiler,
			[],
			"show private orchid data",
		);
		expect(result.status).toBe("refused");
		expect(result.panel.type).toBe("refusal");
		expect(called).toBe(false);
	});

	it("exposes /ask only when a compiler is configured", async () => {
		const server = await buildServer(services, true);
		try {
			const response = await server.inject({
				method: "POST",
				url: "/api/v1/ask",
				headers: {
					"x-dev-principal": JSON.stringify({
						kind: "user",
						id: "test-user",
						scopes: ["fleet"],
						lanes: [],
					}),
				},
				payload: { question: "count events" },
			});
			expect(response.statusCode).toBe(503);
			expect(response.json().error.code).toBe("assistant_unavailable");
			const extra = await server.inject({
				method: "POST",
				url: "/api/v1/ask",
				headers: {
					"x-dev-principal": JSON.stringify({
						kind: "user",
						id: "test-user",
						scopes: ["fleet"],
						lanes: [],
					}),
				},
				payload: { question: "count events", unexpected: true },
			});
			expect(extra.statusCode).toBe(400);
			expect(extra.json().error.code).toBe("bad_question");
		} finally {
			await server.close();
		}
	});

	it("reports repeated compiler outages through the HTTP exception path", async () => {
		const captured: unknown[] = [];
		const assistant: AssistantCompiler = {
			async compile() {
				throw new AssistantCompilerError("upstream private detail");
			},
		};
		const server = await buildServer({ ...services, assistant }, true, {
			captureException(error) {
				captured.push(error);
			},
			async close() {
				return true;
			},
		});
		try {
			const response = await server.inject({
				method: "POST",
				url: "/api/v1/ask",
				headers: {
					"x-dev-principal": JSON.stringify({
						kind: "user",
						id: "test-user",
						scopes: ["fleet"],
						lanes: [],
					}),
				},
				payload: { question: "count all visible events" },
			});
			expect(response.statusCode).toBe(500);
			expect(response.json().error).toMatchObject({ code: "internal_error", retryable: true });
			expect(captured).toHaveLength(1);
			expect(String(captured[0])).not.toContain("upstream private detail");
		} finally {
			await server.close();
		}
	});

	it("rejects substring and invented-time filters during bounded repair", async () => {
		const type = `test.ground_${randomBytes(4).toString("hex")}`;
		await services.emit("test:emitter", emission({ type, dimensions: { zone: "north" } }), 300);
		const feedback: string[] = [];
		const compiler: AssistantCompiler = {
			async compile(input) {
				if (input.feedback) feedback.push(input.feedback.code);
				return {
					feasible: true,
					request: {
						schema_version: 1,
						mode: "structured",
						from: type,
						where: { zone: "nor" },
						time: { from: "-24h" },
					},
					panel: { type: "table", title: "Grounding test" },
				};
			},
		};
		const result = await ask(
			{ app: services.db.app, ro: services.db.ro },
			compiler,
			["fleet"],
			`show ${type} for north`,
		);
		expect(result.status).toBe("refused");
		expect(feedback).toEqual(["ungrounded_filter"]);
	});

	it("rejects an all-wildcard LIKE filter as ungrounded", async () => {
		const type = `test.like_ground_${randomBytes(4).toString("hex")}`;
		await services.emit("test:emitter", emission({ type, dimensions: { zone: "north" } }), 300);
		const compiler: AssistantCompiler = {
			async compile() {
				return {
					feasible: true,
					request: {
						schema_version: 1,
						mode: "structured",
						from: type,
						where: { zone: { op: "like", value: "%" } },
					},
					panel: { type: "table", title: "Wildcard" },
				};
			},
		};
		const result = await ask(
			{ app: services.db.app, ro: services.db.ro },
			compiler,
			["fleet"],
			`show ${type}`,
		);
		expect(result.status).toBe("refused");
	});

	it("saves scoped investigation state and replays panels as the viewer", async () => {
		const query = await runStructured(services.db.app, ["fleet"], {
			schema_version: 1,
			mode: "structured",
			from: "events",
			select: [{ field: "seq", agg: "count", as: "events" }],
		});
		const server = await buildServer(services, true);
		const fleet = {
			"x-dev-principal": JSON.stringify({
				kind: "human",
				id: "tester",
				scopes: ["fleet"],
				lanes: ["viewer"],
			}),
		};
		try {
			const mutationId = randomUUID();
			const payload = {
				schema_version: 1,
				id: mutationId,
				title: "Fleet investigation",
				scope: "fleet",
				panels: [
					{
						schema_version: 2,
						type: "stat",
						title: "Events",
						query_ref: query.query_ref,
						encoding: { value: "events" },
					},
				],
				branch: {
					parent_dashboard_id: null,
					parent_question: "How many events?",
					filters: { scope: "fleet" },
					selected_mark: {
						element_kind: "stat",
						field: "events",
						query_ref: query.query_ref,
						datum: { events: 99 },
					},
					assumptions: ["fleet scope"],
				},
			};
			const saved = await server.inject({
				method: "POST",
				url: "/api/v1/dashboards",
				headers: fleet,
				payload,
			});
			expect(saved.statusCode, saved.body).toBe(200);
			const id = saved.json().id as string;
			expect(saved.json().payload.panels[0].query_ref).not.toBe(query.query_ref);
			expect(saved.json().payload.branch.selected_mark).not.toHaveProperty("datum");
			const retry = await server.inject({
				method: "POST",
				url: "/api/v1/dashboards",
				headers: fleet,
				payload,
			});
			expect(retry.json().id).toBe(id);
			const reused = await server.inject({
				method: "POST",
				url: "/api/v1/dashboards",
				headers: fleet,
				payload: { ...payload, title: "Changed" },
			});
			expect(reused.statusCode).toBe(400);
			expect(reused.json().error.code).toBe("id_reused");
			const loaded = await server.inject({
				method: "GET",
				url: `/api/v1/dashboards/${id}`,
				headers: fleet,
			});
			expect(loaded.statusCode).toBe(200);
			expect(loaded.json().payload.branch.parent_question).toBe("How many events?");
			expect(loaded.json().materialized_panels[0]).toMatchObject({
				panel: { type: "stat" },
				render: { renderer: "native", data_query_ref: expect.stringMatching(/^q_/) },
			});
			const hidden = await server.inject({
				method: "GET",
				url: `/api/v1/dashboards/${id}`,
				headers: {
					"x-dev-principal": JSON.stringify({
						kind: "human",
						id: "outsider",
						scopes: ["user:outsider"],
						lanes: ["viewer"],
					}),
				},
			});
			expect(hidden.statusCode).toBe(404);
		} finally {
			await server.close();
		}
	});

	it("refuses to save a query into a broader dashboard scope", async () => {
		const type = `test.private_${randomBytes(4).toString("hex")}`;
		await services.emit(
			"test:emitter",
			emission({ type, scope: "user:secret", measures: { value: 7 } }),
			300,
		);
		const query = await runStructured(services.db.app, ["user:secret"], {
			schema_version: 1,
			mode: "structured",
			from: type,
			select: [{ field: "value", agg: "avg", as: "secret" }],
		});
		const server = await buildServer(services, true);
		try {
			const response = await server.inject({
				method: "POST",
				url: "/api/v1/dashboards",
				headers: {
					"x-dev-principal": JSON.stringify({
						kind: "human",
						id: "author",
						scopes: ["user:secret", "user:public"],
						lanes: ["viewer"],
					}),
				},
				payload: {
					schema_version: 1,
					id: randomUUID(),
					title: "Unsafe",
					scope: "user:public",
					panels: [
						{
							schema_version: 2,
							type: "stat",
							title: "Secret",
							query_ref: query.query_ref,
							narrative: "secret: 7",
						},
					],
				},
			});
			expect(response.statusCode).toBe(400);
			expect(response.json().error.code).toBe("query_not_shareable");
		} finally {
			await server.close();
		}
	});

	it("resolves saved text stat bindings as the viewer and paginates dashboards", async () => {
		const query = await runStructured(services.db.app, ["fleet"], {
			schema_version: 1,
			mode: "structured",
			from: "events",
			select: [{ field: "seq", agg: "count", as: "events" }],
		});
		const server = await buildServer(services, true);
		const headers = {
			"x-dev-principal": JSON.stringify({
				kind: "human",
				id: "binding-user",
				scopes: ["fleet"],
				lanes: ["viewer"],
			}),
		};
		try {
			const saved = await server.inject({
				method: "POST",
				url: "/api/v1/dashboards",
				headers,
				payload: {
					schema_version: 1,
					id: randomUUID(),
					title: "Bound prose",
					scope: "fleet",
					panels: [
						{
							schema_version: 2,
							type: "text",
							title: "Summary",
							prose: `Visible events: {{stat:${query.query_ref}#events[count]}}`,
						},
					],
				},
			});
			expect(saved.statusCode, saved.body).toBe(200);
			const loaded = await server.inject({
				method: "GET",
				url: `/api/v1/dashboards/${String(saved.json().id)}`,
				headers,
			});
			expect(loaded.json().materialized_panels[0].render.bindings[0]).toMatchObject({
				column: "events",
				status: "resolved",
				query_ref: expect.stringMatching(/^q_/),
			});
			const another = await server.inject({
				method: "POST",
				url: "/api/v1/dashboards",
				headers,
				payload: {
					schema_version: 1,
					id: randomUUID(),
					title: "Second page",
					scope: "fleet",
					panels: [
						{
							schema_version: 2,
							type: "text",
							title: "Notes",
							prose: "No bound statistics.",
						},
					],
				},
			});
			expect(another.statusCode, another.body).toBe(200);
			const cursorHigh = `dash_${randomBytes(12).toString("hex")}`;
			const cursorLow = `dash_${randomBytes(12).toString("hex")}`;
			const cursorPayload = {
				schema_version: 1,
				layout: {},
				panels: [{ schema_version: 2, type: "text", title: "Cursor", prose: "Cursor" }],
				query_refs: [],
				branch: null,
				time: null,
			};
			await services.db.writer`
				insert into items_min (id, kind, title, scope, created_by, payload, updated_at)
				values
					(${cursorHigh}, 'artifact', 'Cursor high', 'fleet', 'binding-user', ${services.db.writer.json(cursorPayload)}, '2099-01-01T00:00:00.123456Z'),
					(${cursorLow}, 'artifact', 'Cursor low', 'fleet', 'binding-user', ${services.db.writer.json(cursorPayload)}, '2099-01-01T00:00:00.123455Z')`;
			const storedCursorRows = await services.db.admin<{ id: string; updated_at: string }[]>`
				select id, updated_at::text as updated_at from items_min
				where id in (${cursorHigh}, ${cursorLow}) order by updated_at desc`;
			expect(storedCursorRows).toEqual([
				{ id: cursorHigh, updated_at: "2099-01-01 00:00:00.123456+00" },
				{ id: cursorLow, updated_at: "2099-01-01 00:00:00.123455+00" },
			]);
			const first = await server.inject({
				method: "GET",
				url: "/api/v1/dashboards?limit=1",
				headers,
			});
			expect(first.json().truncated).toBe(true);
			expect(first.json().next_cursor).toEqual(expect.any(String));
			expect(first.json().items[0].id).toBe(cursorHigh);
			const [cursorPayloadPart] = String(first.json().next_cursor).split(".");
			const decodedCursor = JSON.parse(
				Buffer.from(String(cursorPayloadPart), "base64url").toString("utf8"),
			) as { position: string };
			expect(decodedCursor.position).toContain(".123456");
			const forged = await server.inject({
				method: "GET",
				url: `/api/v1/dashboards?limit=1&cursor=${encodeURIComponent(`${String(cursorPayloadPart)}.invalid`)}`,
				headers,
			});
			expect(forged.statusCode).toBe(400);
			const second = await server.inject({
				method: "GET",
				url: `/api/v1/dashboards?limit=1&cursor=${encodeURIComponent(String(first.json().next_cursor))}`,
				headers,
			});
			expect(second.statusCode).toBe(200);
			expect(
				second.json().items[0].id,
				JSON.stringify({ cursorHigh, cursorLow, first: first.json(), second: second.json() }),
			).toBe(cursorLow);
		} finally {
			await server.close();
		}
	});

	it("serves the scoped Rev3 Library, personal holds, curation, and registry capabilities", async () => {
		const visibleId = `lib_${randomBytes(12).toString("hex")}`;
		const targetId = `lib_${randomBytes(12).toString("hex")}`;
		const hiddenId = `lib_${randomBytes(12).toString("hex")}`;
		const capabilityId = `lib_${randomBytes(12).toString("hex")}`;
		const capabilityBlobId = `blob_${randomBytes(12).toString("hex")}`;
		const hiddenCapabilityId = `lib_${randomBytes(12).toString("hex")}`;
		const hiddenCapabilityBlobId = `blob_${randomBytes(12).toString("hex")}`;
		const unsignedCapabilityId = `lib_${randomBytes(12).toString("hex")}`;
		const capabilityBundle = Buffer.from(
			JSON.stringify({
				schema_version: 1,
				entrypoint: "SKILL.md",
				files: [
					{
						path: "SKILL.md",
						mode: 420,
						content_b64: Buffer.from("# Fleet retry discipline\n").toString("base64"),
					},
				],
			}),
		);
		const capabilityDigest = createHash("sha256").update(capabilityBundle).digest("hex");
		await services.db.writer`
			insert into library_items
			  (id, entity_id, kind, title, scope, project, status, properties, created_by,
			   responsible_human, protection)
			values
			  (${visibleId}, ${visibleId}, 'how-to', 'Fleet retry discipline', 'fleet', 'console',
			   'verified-shared', ${services.db.writer.json({ body: "bounded retry with jitter" })}, 'janet', 'binding-user', 'semi'),
			  (${targetId}, ${targetId}, 'doc', 'Library item model', 'fleet', 'console',
			   'verified-shared', ${services.db.writer.json({ body: "one item and typed links" })}, 'janet', 'binding-user', 'semi'),
			  (${capabilityId}, ${capabilityId}, 'artifact', 'Fleet retry skill', 'fleet', 'registry',
			   'verified-shared', ${services.db.writer.json({ artifact_type: "capability", capability: "skill.fleet-retry", capability_kind: "skill", version: "1.2.0", sha256: capabilityDigest })}, 'janet', 'binding-user', 'semi'),
			  (${hiddenId}, ${hiddenId}, 'doc', 'Private book', 'user:secret', 'secret',
			   'draft', ${services.db.writer.json({ body: "must not leak" })}, 'janet', 'secret', 'full')`;
		await services.db.writer`
			update library_items set body_ref = ${capabilityBlobId} where id = ${capabilityId}`;
		await services.db.writer`
			insert into library_items
			  (id, entity_id, kind, title, scope, project, status, body_ref, properties)
			values (${unsignedCapabilityId}, ${unsignedCapabilityId}, 'artifact', 'Unsigned skill',
			  'fleet', 'registry', 'verified-shared', ${capabilityBlobId},
			  ${services.db.writer.json({ artifact_type: "capability", capability: "skill.unsigned", capability_kind: "skill", version: "1.0.0" })})`;
		await services.db.writer`
			insert into blobs (id, scope, bytes) values (${capabilityBlobId}, 'fleet', ${capabilityBundle})`;
		await services.db.writer`
			insert into library_items
			  (id, entity_id, kind, title, scope, project, status, body_ref, properties)
			values (${hiddenCapabilityId}, ${hiddenCapabilityId}, 'artifact', 'Secret skill',
			  'user:secret', 'registry', 'verified-shared', ${hiddenCapabilityBlobId},
			  ${services.db.writer.json({ artifact_type: "capability", capability: "skill.secret", capability_kind: "skill", version: "1.0.0", sha256: capabilityDigest })})`;
		await services.db.writer`
			insert into blobs (id, scope, bytes)
			values (${hiddenCapabilityBlobId}, 'user:secret', ${capabilityBundle})`;
		await services.db.writer`
			insert into library_links (from_id, to_id, rel_type, reason, scope)
			values (${visibleId}, ${targetId}, 'references', 'Uses the Rev3 model', 'fleet')`;
		await services.db.writer`
			insert into library_holds (item_id, for_principal, reason, scope)
			values (${visibleId}, 'binding-user', 'recommended', 'fleet')`;
		await services.db.writer`
			insert into library_curation
			  (id, item_id, proposal_type, reason, scope, links_in, active_task_links)
			values (${`cur_${randomBytes(12).toString("hex")}`}, ${targetId}, 'dedup',
			  'Possible duplicate', 'fleet', 1, 0)`;
		await services.db.writer`
			insert into current_state (kind, subject, scope, state, observed_at, seq)
			values ('registry', 'agent:library-test', 'fleet',
			  ${services.db.writer.json({ provides: ["kb.search", "mcp.library", "skill.fleet-retry", "skill.unsigned"], host: ".14", transport: "mcp" })},
			  now(), 990001)
			on conflict (kind, subject) do update set state = excluded.state,
			  observed_at = excluded.observed_at, seq = excluded.seq`;
		await services.db.writer`
			insert into current_state (kind, subject, scope, state, observed_at, seq)
			values ('registry', 'agent:secret-library', 'user:secret',
			  ${services.db.writer.json({ provides: ["skill.secret"] })}, now(), 990002)
			on conflict (kind, subject) do update set state = excluded.state,
			  observed_at = excluded.observed_at, seq = excluded.seq`;
		await services.db.admin`
			insert into grants (subject, relation, object, granted_by)
			values ('binding-user', 'editor', ${`item:${visibleId}`}, 'test'), ('binding-user', 'owner', 'fleet', 'test')`;
		const server = await buildServer(services, true);
		const headers = {
			"x-dev-principal": JSON.stringify({
				kind: "human",
				id: "binding-user",
				scopes: ["fleet", "user:binding-user"],
				lanes: ["viewer"],
			}),
		};
		try {
			const items = await server.inject({
				method: "GET",
				url: "/api/v1/library/items?limit=500",
				headers,
			});
			expect(items.statusCode, items.body).toBe(200);
			expect(items.json().items).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: visibleId, kind: "how-to", project: "console" }),
				]),
			);
			expect(items.json().items).not.toEqual(
				expect.arrayContaining([expect.objectContaining({ id: hiddenId })]),
			);
			const detail = await server.inject({
				method: "GET",
				url: `/api/v1/library/items/${visibleId}`,
				headers,
			});
			expect(detail.statusCode, detail.body).toBe(200);
			expect(detail.json()).toMatchObject({
				freshness: { source: "library" },
				item: { id: visibleId, entity_id: visibleId },
			});
			const hiddenDetail = await server.inject({
				method: "GET",
				url: `/api/v1/library/items/${hiddenId}`,
				headers,
			});
			expect(hiddenDetail.statusCode).toBe(404);
			const firstPage = await server.inject({
				method: "GET",
				url: "/api/v1/library/items?limit=1",
				headers,
			});
			expect(firstPage.json()).toMatchObject({
				truncated: true,
				next_cursor: expect.any(String),
			});
			const secondPage = await server.inject({
				method: "GET",
				url: `/api/v1/library/items?limit=1&cursor=${encodeURIComponent(String(firstPage.json().next_cursor))}`,
				headers,
			});
			expect(secondPage.statusCode, secondPage.body).toBe(200);
			expect(secondPage.json().items[0].id).not.toBe(firstPage.json().items[0].id);

			const search = await server.inject({
				method: "GET",
				url: "/api/v1/library/search?q=jitter",
				headers,
			});
			expect(search.statusCode, search.body).toBe(200);
			expect(search.json()).toMatchObject({
				search: { mode: "lexical", dense_index: "unavailable", degraded: true },
				items: [expect.objectContaining({ id: visibleId })],
			});

			const [links, holds, curation, capabilities] = await Promise.all([
				server.inject({ method: "GET", url: "/api/v1/library/links", headers }),
				server.inject({ method: "GET", url: "/api/v1/library/holds", headers }),
				server.inject({ method: "GET", url: "/api/v1/library/curation", headers }),
				server.inject({ method: "GET", url: "/api/v1/library/capabilities", headers }),
			]);
			expect(links.json().items).toContainEqual(
				expect.objectContaining({ from_id: visibleId, to_id: targetId, rel_type: "references" }),
			);
			expect(holds.json().items).toContainEqual(
				expect.objectContaining({ item_id: visibleId, reason: "recommended" }),
			);
			expect(curation.json().items).toContainEqual(
				expect.objectContaining({ item_id: targetId, proposal_type: "dedup" }),
			);
			expect(capabilities.json().items).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						capability: "mcp.library",
						provider: "agent:library-test",
						fresh: true,
					}),
				]),
			);
			const firstCapabilityPage = await server.inject({
				method: "GET",
				url: "/api/v1/library/capabilities?limit=1",
				headers,
			});
			expect(firstCapabilityPage.json()).toMatchObject({
				truncated: true,
				next_cursor: expect.any(String),
				items: [expect.objectContaining({ provider: "agent:library-test" })],
			});
			const secondCapabilityPage = await server.inject({
				method: "GET",
				url: `/api/v1/library/capabilities?limit=1&cursor=${encodeURIComponent(String(firstCapabilityPage.json().next_cursor))}`,
				headers,
			});
			expect(secondCapabilityPage.statusCode, secondCapabilityPage.body).toBe(200);
			expect(secondCapabilityPage.json().items).toHaveLength(1);
			expect(secondCapabilityPage.json().items[0].capability).not.toBe(
				firstCapabilityPage.json().items[0].capability,
			);
			const acquired = await server.inject({
				method: "POST",
				url: "/api/v1/library/capabilities/skill.fleet-retry/acquire",
				headers,
				payload: { provider: "agent:library-test" },
			});
			expect(acquired.statusCode, acquired.body).toBe(200);
			expect(acquired.json()).toMatchObject({
				schema_version: 1,
				capability: "skill.fleet-retry",
				kind: "skill",
				version: "1.2.0",
				provider: "agent:library-test",
				scope: "fleet",
				integrity: { algorithm: "sha256", digest: capabilityDigest },
				artifact: {
					media_type: "application/vnd.petalnet.capability-bundle+json",
					encoding: "base64",
				},
				provenance: { library_item_id: capabilityId, created_by_agent: "janet" },
			});
			expect(Buffer.from(acquired.json().artifact.data, "base64")).toEqual(capabilityBundle);
			const absent = await server.inject({
				method: "POST",
				url: "/api/v1/library/capabilities/skill.not-visible/acquire",
				headers,
				payload: {},
			});
			expect(absent.statusCode).toBe(404);
			const hiddenCapability = await server.inject({
				method: "POST",
				url: "/api/v1/library/capabilities/skill.secret/acquire",
				headers,
				payload: { provider: "agent:secret-library" },
			});
			expect(hiddenCapability.statusCode).toBe(404);
			const unsignedCapability = await server.inject({
				method: "POST",
				url: "/api/v1/library/capabilities/skill.unsigned/acquire",
				headers,
				payload: { provider: "agent:library-test" },
			});
			expect(unsignedCapability.statusCode).toBe(422);
			expect(unsignedCapability.json()).toMatchObject({
				error: { code: "capability_artifact_invalid" },
			});
			const agentHeaders = {
				"x-dev-principal": JSON.stringify({
					kind: "agent",
					id: "agent:reflector",
					scopes: ["fleet"],
					lanes: ["viewer"],
				}),
			};
			const proposed = await server.inject({
				method: "POST",
				url: "/api/v1/op",
				headers: agentHeaders,
				payload: {
					schema_version: 1,
					id: randomUUID(),
					op: "library.capability.propose",
					args: {
						capability: "skill.agent-reflection",
						title: "Agent reflection",
						version: "1.0.0",
						scope: "fleet",
						artifact_base64: Buffer.from('{"name":"skill.agent-reflection"}').toString("base64"),
					},
					reason: "Captured a reusable reflection workflow",
					dry_run: false,
				},
			});
			expect(proposed.statusCode, proposed.body).toBe(200);
			expect(proposed.json()).toMatchObject({
				ok: true,
				result: { capability: "skill.agent-reflection", state: "proposed" },
			});
			const proposalId = String(proposed.json().result.proposal_id);
			const beforePromotion = await server.inject({
				method: "GET",
				url: "/api/v1/library/capabilities",
				headers,
			});
			expect(beforePromotion.json().items).not.toEqual(
				expect.arrayContaining([expect.objectContaining({ capability: "skill.agent-reflection" })]),
			);
			const agentPromote = await server.inject({
				method: "POST",
				url: "/api/v1/op",
				headers: agentHeaders,
				payload: {
					schema_version: 1,
					id: randomUUID(),
					op: "library.capability.review",
					args: { proposal_id: proposalId, decision: "promoted" },
					reason: "self approve",
					dry_run: false,
				},
			});
			expect(agentPromote.statusCode).toBe(403);
			const adminHeaders = {
				"x-dev-principal": JSON.stringify({
					kind: "human",
					id: "binding-user",
					scopes: ["fleet", "user:binding-user"],
					lanes: ["viewer", "admin"],
				}),
			};
			const promoted = await server.inject({
				method: "POST",
				url: "/api/v1/op",
				headers: adminHeaders,
				payload: {
					schema_version: 1,
					id: randomUUID(),
					op: "library.capability.review",
					args: { proposal_id: proposalId, decision: "promoted" },
					reason: "Artifact and provenance reviewed",
					dry_run: false,
				},
			});
			expect(promoted.statusCode, promoted.body).toBe(200);
			expect(promoted.json()).toMatchObject({
				ok: true,
				result: {
					capability: "skill.agent-reflection",
					state: "promoted",
					reviewed_by: "binding-user",
				},
			});
			const afterPromotion = await server.inject({
				method: "GET",
				url: "/api/v1/library/capabilities",
				headers,
			});
			expect(afterPromotion.json().items).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						capability: "skill.agent-reflection",
						provider: `proposal:${proposalId}`,
					}),
				]),
			);

			const editorHeaders = {
				"x-dev-principal": JSON.stringify({
					kind: "human",
					id: "binding-user",
					scopes: ["fleet", "user:binding-user"],
					lanes: ["viewer", "editor"],
				}),
			};
			const update = await server.inject({
				method: "POST",
				url: "/api/v1/op",
				headers: editorHeaders,
				payload: {
					schema_version: 1,
					id: randomUUID(),
					op: "library.item.update",
					args: { id: visibleId, patch: { status: "draft", expected_version: 1 } },
					dry_run: false,
				},
			});
			expect(update.statusCode, update.body).toBe(200);
			expect(update.json()).toMatchObject({
				ok: true,
				result: { id: visibleId, status: "draft", version: 2 },
				executor: { kind: "library", liveness: "alive" },
			});
			const conflict = await server.inject({
				method: "POST",
				url: "/api/v1/op",
				headers: editorHeaders,
				payload: {
					schema_version: 1,
					id: randomUUID(),
					op: "library.item.update",
					args: { id: visibleId, patch: { status: "superseded", expected_version: 1 } },
					dry_run: false,
				},
			});
			expect(conflict.statusCode, conflict.body).toBe(200);
			expect(conflict.json()).toMatchObject({
				ok: true,
				result: {
					id: visibleId,
					status: "CONFLICT",
					version: 3,
					conflict: { values: ["draft", "superseded"] },
				},
			});
		} finally {
			await server.close();
		}
	});

	it("replays query refs through the chart render API", async () => {
		const query = await runStructured(services.db.app, ["fleet"], {
			schema_version: 1,
			mode: "structured",
			from: "events",
			select: [{ field: "seq", agg: "count", as: "events" }],
			group_by: ["severity"],
		});
		const server = await buildServer(services, true);
		try {
			const response = await server.inject({
				method: "POST",
				url: "/api/v1/render",
				headers: {
					"x-dev-principal": JSON.stringify({
						kind: "human",
						id: "tester",
						scopes: ["fleet"],
						lanes: ["viewer"],
					}),
				},
				payload: {
					query_ref: query.query_ref,
					panel: {
						schema_version: 2,
						type: "bar",
						title: "Events by severity",
						query_ref: query.query_ref,
						encoding: { x: "severity", y: "events" },
					},
				},
			});
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({
				panel: { type: "bar" },
				render: { renderer: "vega-lite", selection_reason: expect.stringContaining("categorical") },
			});
		} finally {
			await server.close();
		}
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

	it("marks every entity from a dark bridge source unreachable and clears them on recovery", async () => {
		const suffix = randomBytes(4).toString("hex");
		const source = `fleet-${suffix}`;
		const affected = [`dark-a-${suffix}`, `dark-b-${suffix}`];
		const unaffected = `healthy-${suffix}`;
		let available = true;
		const bridge = new Bridge(
			services.db.writer,
			(subject, event, bytes) => services.emit(subject, event, bytes),
			{
				adapters: [
					{
						source,
						producerSubject: "bridge:fleet",
						poll(cursor, now) {
							if (!available) throw new Error("source unavailable");
							return {
								cursor: "healthy",
								emissions:
									cursor === ""
										? affected.map((subject) =>
												emission({
													type: "fleet.event.stop",
													ts: now,
													source: { service: "bridge", host: ".10", agent: subject },
													subject,
													subject_kind: "agent",
													dimensions: { status: "idle" },
												}),
											)
										: [],
							};
						},
					},
				],
			},
		);

		await bridge.pollOnce("2026-07-13T00:00:00Z");
		for (const subject of affected) await waitProjected("fleet", subject, 1);
		const other = await services.emit(
			"bridge:fleet",
			emission({
				type: "fleet.event.stop",
				source: { service: "bridge", host: ".11", agent: unaffected },
				subject: unaffected,
				subject_kind: "agent",
				dimensions: { status: "idle" },
				meta: { bridge_source: { kind: "bridge_source", id: `other-${suffix}` } },
			}),
			400,
		);
		await waitProjected("fleet", unaffected, other.seq as number);

		available = false;
		await bridge.pollOnce("2026-07-13T00:00:05Z");
		for (let i = 0; i < 50; i++) {
			const rows = await services.db.admin<
				{ subject: string; unreachable_since: string | null }[]
			>`select subject, unreachable_since from current_state
			  where subject in ${services.db.admin(affected.concat(unaffected))}`;
			if (
				affected.every(
					(subject) => rows.find((row) => row.subject === subject)?.unreachable_since,
				) &&
				rows.find((row) => row.subject === unaffected)?.unreachable_since === null
			)
				break;
			if (i === 49) throw new Error("affected source rows never became unreachable");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}

		available = true;
		await bridge.pollOnce("2026-07-13T00:00:10Z");
		for (let i = 0; i < 50; i++) {
			const rows = await services.db.admin<{ unreachable_since: string | null }[]>`
				select unreachable_since from current_state where subject in ${services.db.admin(affected)}`;
			if (rows.length === affected.length && rows.every((row) => row.unreachable_since === null))
				return;
			if (i === 49) throw new Error("recovered source rows stayed unreachable");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	});

	it("serves every BR-008 typed read from its scoped projection with contract-valid shapes", async () => {
		const suffix = randomBytes(4).toString("hex");
		const now = new Date().toISOString();
		const sessionId = `session-${suffix}`;
		const fingerprint = `sha256:${suffix}`;
		const attentionId = `attention-${suffix}`;
		const boxId = `a1:${suffix}`;
		const subscriptionSubject = `subscription:eli:${suffix}`;

		const enrolled = await services.emit(
			"bridge:doorman",
			emission({
				type: "doorman.enroll.request",
				source: { service: "doorman", host: ".14", agent: null },
				subject: fingerprint,
				subject_kind: "other",
				meta: {
					entity: {
						pubkey_fp: fingerprint,
						handle: null,
						host: ".14",
						state: "pending",
						requested_handle: `edge-${suffix}`,
						first_seen_at: now,
					},
				},
			}),
			800,
		);
		const opened = await services.emit(
			"bridge:doorman",
			emission({
				type: "doorman.session.opened",
				source: { service: "doorman", host: ".14", agent: null },
				subject: sessionId,
				subject_kind: "session",
				meta: {
					entity: {
						session_id: sessionId,
						handle: `edge-${suffix}`,
						host: ".14",
						state: "open",
						established_at: now,
						resumes_count: 0,
						last_seen_at: now,
						links: [
							{
								link_id: `link-${suffix}`,
								role: "primary",
								state: "active",
								established_at: now,
								flap_count_24h: 0,
							},
						],
					},
				},
			}),
			1_200,
		);
		const unrelatedDoorman = await services.emit(
			"bridge:doorman",
			emission({
				type: "doorman.health",
				source: { service: "doorman", host: ".14", agent: null },
				subject: `doorman-${suffix}`,
			}),
			400,
		);
		const projectorFence = await services.emit(
			"bridge:fleet",
			emission({
				type: "fleet.event.stop",
				source: { service: "bridge", host: ".14", agent: `fence-${suffix}` },
				subject: `fence-${suffix}`,
				subject_kind: "agent",
				dimensions: { status: "idle" },
			}),
			400,
		);
		expect(enrolled.ok).toBe(true);
		expect(opened.ok).toBe(true);
		expect(unrelatedDoorman.ok).toBe(true);
		expect(projectorFence.ok).toBe(true);
		await waitProjected("edge", fingerprint, enrolled.seq as number);
		await waitProjected("edge_session", sessionId, opened.seq as number);
		await waitProjected("fleet", `fence-${suffix}`, projectorFence.seq as number);
		expect(
			await services.db.admin`
				select 1 from current_state where kind = 'edge_session' and subject = ${`doorman-${suffix}`}`,
		).toHaveLength(0);

		const subscription = {
			schema_version: 1,
			pattern: `task.${suffix}`,
			filter: null,
			tier: "digest",
			window: "18:00",
			loud: false,
			note: null,
			owner: "eli",
			updated_by: "eli",
			updated_at: now,
		};
		const delivery = {
			owner: "eli",
			channel: "matrix",
			target: "@eli:example.test",
			verified: true,
			cocoon_until: null,
			next_digest_at: null,
			updated_at: now,
			updated_by: "eli",
		};
		const attention = {
			schema_version: 1,
			id: attentionId,
			grade: "blocker",
			source: "tracker",
			subject: `task:${suffix}`,
			summary: "A task needs a decision.",
			ts: now,
			scope: "user:eli",
			fix_ops: [{ op: "task.update", args: { id: 42 } }],
		};
		const raw = {
			box_id: boxId,
			packages: [{ name: "openssl", from: "3.0.0", to: "3.0.1", security: true }],
			vulns: [
				{ cve_id: "CVE-2026-12345", severity: "high", package: "openssl", fixed_in: "3.0.1" },
			],
			collected_at: now,
		};
		const subscriptionResult = await services.emit(
			"system:console-api",
			emission({
				type: "subscription.changed",
				source: { service: "console-api", host: null, agent: null },
				subject: subscriptionSubject,
				subject_kind: "other",
				scope: "user:eli",
				meta: { entity: subscription },
			}),
			900,
		);
		await services.db.writer`
			insert into delivery_config
				(owner, scope, channel, target, verified, cocoon_until, next_digest_at, updated_at, updated_by)
			values
				(${delivery.owner}, 'user:eli', ${delivery.channel}, ${delivery.target}, ${delivery.verified},
				 ${delivery.cocoon_until}, ${delivery.next_digest_at}, ${delivery.updated_at}, ${delivery.updated_by})
			on conflict (owner) do update set target = excluded.target, verified = excluded.verified,
				updated_at = excluded.updated_at, updated_by = excluded.updated_by`;
		const attentionResult = await services.emit(
			"system:console-api",
			emission({
				type: "attention.created",
				source: { service: "console-api", host: null, agent: null },
				subject: attentionId,
				subject_kind: "other",
				scope: "user:eli",
				meta: { entity: attention },
			}),
			900,
		);
		const boxResult = await services.emit(
			"bridge:hosts",
			emission({
				type: "box.update_status_changed",
				source: { service: "bridge", host: ".14", agent: null },
				subject: boxId,
				subject_kind: "host",
				meta: { box_update_raw: raw },
			}),
			1_200,
		);
		for (const result of [subscriptionResult, attentionResult, boxResult])
			expect(result.ok).toBe(true);
		await waitProjected("subscription", subscriptionSubject, subscriptionResult.seq as number);
		await waitProjected("attention", attentionId, attentionResult.seq as number);
		await waitProjected("box_update", boxId, boxResult.seq as number);

		const schemas = (name: string): Record<string, unknown> =>
			JSON.parse(
				readFileSync(
					new URL(`../docs/contracts/schemas/${name}.schema.json`, import.meta.url),
					"utf8",
				),
			) as Record<string, unknown>;
		const envelopeSchema = schemas("entities/read-envelope");
		const server = await buildServer(services, true);
		const fleetPrincipal = JSON.stringify({
			kind: "human",
			id: "eli",
			scopes: ["fleet", "user:eli"],
			lanes: ["viewer"],
		});
		const hiddenPrincipal = JSON.stringify({
			kind: "human",
			id: "secret",
			scopes: ["user:secret"],
			lanes: ["viewer"],
		});
		try {
			for (const [path, itemSchema, identity] of [
				["edge/registry", "entities/edge-registry", ["pubkey_fp", fingerprint]],
				["edge/sessions", "entities/edge-session", ["session_id", sessionId]],
				["subscriptions", "subscription", ["pattern", subscription.pattern]],
				["delivery", "entities/delivery", ["owner", "eli"]],
				["attention", "attention-item", ["id", attentionId]],
			] as const) {
				const response = await server.inject({
					method: "GET",
					url: `/api/v1/${path}`,
					headers: { "x-dev-principal": fleetPrincipal },
				});
				expect(response.statusCode, response.body).toBe(200);
				const body = response.json();
				expect(validateJsonSchema(body, envelopeSchema, "response")).toBeNull();
				const item = body.items.find(
					(candidate: Record<string, unknown>) => candidate[identity[0]] === identity[1],
				);
				expect(item).toBeDefined();
				for (const candidate of body.items)
					expect(validateJsonSchema(candidate, schemas(itemSchema), "item")).toBeNull();
			}
			const filteredSession = await server.inject({
				method: "GET",
				url: `/api/v1/edge/sessions?handle=${encodeURIComponent(`edge-${suffix}`)}&state=open&since=${encodeURIComponent(now)}`,
				headers: { "x-dev-principal": fleetPrincipal },
			});
			expect(filteredSession.json().items).toEqual([
				expect.objectContaining({ session_id: sessionId }),
			]);
			const excludedSession = await server.inject({
				method: "GET",
				url: "/api/v1/edge/sessions?state=closed",
				headers: { "x-dev-principal": fleetPrincipal },
			});
			expect(excludedSession.json().items).toEqual([]);
			const otherOwner = await server.inject({
				method: "GET",
				url: "/api/v1/subscriptions?owner=parker",
				headers: { "x-dev-principal": fleetPrincipal },
			});
			expect(otherOwner.json().items).toEqual([]);
			const badSince = await server.inject({
				method: "GET",
				url: "/api/v1/attention?since=not-a-date",
				headers: { "x-dev-principal": fleetPrincipal },
			});
			expect(badSince.statusCode).toBe(400);

			const rawResponse = await server.inject({
				method: "GET",
				url: `/api/v1/box-updates/${encodeURIComponent(boxId)}/raw`,
				headers: { "x-dev-principal": fleetPrincipal },
			});
			expect(rawResponse.statusCode, rawResponse.body).toBe(200);
			expect(
				validateJsonSchema(rawResponse.json(), schemas("entities/box-update-raw"), "item"),
			).toBeNull();

			for (const path of ["subscriptions", "delivery", "attention"]) {
				const hidden = await server.inject({
					method: "GET",
					url: `/api/v1/${path}`,
					headers: { "x-dev-principal": hiddenPrincipal },
				});
				expect(hidden.json().items).toEqual([]);
			}
			const hiddenRaw = await server.inject({
				method: "GET",
				url: `/api/v1/box-updates/${encodeURIComponent(boxId)}/raw`,
				headers: { "x-dev-principal": hiddenPrincipal },
			});
			const missingRaw = await server.inject({
				method: "GET",
				url: "/api/v1/box-updates/does-not-exist/raw",
				headers: { "x-dev-principal": hiddenPrincipal },
			});
			expect(hiddenRaw.statusCode).toBe(404);
			expect(hiddenRaw.json()).toEqual(missingRaw.json());

			await services.db.writer`delete from current_state
				where (kind = 'edge_session' and subject = ${sessionId})
				   or (kind = 'subscription' and subject = ${subscriptionSubject})
				   or (kind = 'attention' and subject = ${attentionId})
				   or (kind = 'box_update' and subject = ${boxId})`;
			await services.db.admin`delete from projection_checkpoint where name = 'current_state_br009'`;
			await services.projector.replayContractedReadsToHead();
			const backfilled = await services.db.admin<
				{ kind: string; state: Record<string, unknown> }[]
			>`select kind, state from current_state
			  where (kind = 'edge_session' and subject = ${sessionId})
			     or (kind = 'subscription' and subject = ${subscriptionSubject})
			     or (kind = 'attention' and subject = ${attentionId})
			     or (kind = 'box_update' and subject = ${boxId})`;
			expect(new Set(backfilled.map((row) => row.kind))).toEqual(
				new Set(["edge_session", "subscription", "attention", "box_update"]),
			);
			expect(
				backfilled.find((row) => row.kind === "box_update")?.state["box_update_raw"],
			).toMatchObject(raw);

			services.projector.onEvent(
				9_100_001,
				emission({
					type: "subscription.changed",
					source: { service: "console-api", host: null, agent: null },
					subject: subscriptionSubject,
					scope: "user:eli",
					action: "remove",
				}),
				now,
			);
			services.projector.onEvent(
				9_100_002,
				emission({
					type: "delivery.receipt",
					source: { service: "console-api", host: null, agent: null },
					subject: `receipt-${suffix}`,
					scope: "user:eli",
				}),
				now,
			);
			services.projector.onEvent(
				9_100_003,
				emission({
					type: "attention.created",
					source: { service: "console-api", host: null, agent: null },
					subject: `sync-${suffix}`,
					scope: "user:eli",
				}),
				now,
			);
			await waitProjected("attention", `sync-${suffix}`, 9_100_003);
			expect(
				await services.db.admin`
					select 1 from current_state
					where (kind = 'subscription' and subject = ${subscriptionSubject})
					   or (kind = 'delivery' and subject = ${`receipt-${suffix}`})`,
			).toHaveLength(0);
		} finally {
			await server.close();
		}
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

	it("roster counts visible worker rows for their owning agent", async () => {
		const event = await services.emit(
			"bridge:box-agent",
			{
				schema_version: 1,
				id: randomUUID(),
				type: "worker.started",
				ts: new Date().toISOString(),
				source: { service: "bridge", host: ".15", agent: "rosterbox" },
				subject: "rosterbox-worker-1",
				subject_kind: "other",
				severity: "info",
				scope: "fleet",
				dimensions: { handle: "rosterbox", label: "focused-test" },
			},
			300,
		);
		await waitProjected("worker", "rosterbox-worker-1", event.seq as number);
		const env = await readRoster(services.db.app, null, ["fleet"]);
		const row = env.items.find((item) => item["handle"] === "rosterbox");
		expect(row?.["workers_active"]).toBe(1);
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

describe("Phase 5 per-user Claude Code manager seam", () => {
	it("keeps one scoped session per principal and exposes seven real MCP tools plus context", async () => {
		const managerCalls: { path: string; body: Record<string, unknown> }[] = [];
		let toolToken = "";
		const toolTokens = new Map<string, string>();
		const receipts = new Map<string, Record<string, unknown>>();
		const manager = createHttpServer((request, response) => {
			let text = "";
			request.setEncoding("utf8");
			request.on("data", (chunk) => {
				text += chunk;
			});
			request.on("end", () => {
				const body = JSON.parse(text) as Record<string, unknown>;
				managerCalls.push({ path: request.url ?? "", body });
				if (request.url === "/v1/sessions/ensure") {
					const principalId = String((body["principal"] as { id?: unknown }).id ?? "unknown");
					const token = String((body["mcp"] as { bearer_token?: unknown }).bearer_token ?? "");
					toolTokens.set(principalId, token);
					if (principalId === "runtime-user") toolToken = token;
					response.writeHead(200, { "content-type": "application/json" });
					response.end(JSON.stringify({ session_id: `claude-session-${principalId}` }));
					return;
				}
				if (request.url?.endsWith("/messages/lookup")) {
					const receipt = receipts.get(String(body["message_id"]));
					response.writeHead(receipt ? 200 : 404, { "content-type": "application/json" });
					response.end(JSON.stringify(receipt ?? { error: "not_found" }));
					return;
				}
				const receipt = {
					message_id: `reply-${String(body["message_id"])}`,
					content: body["kind"] === "context" ? "Context received." : "I can use the tools.",
					tool_results: [],
				};
				receipts.set(String(body["message_id"]), receipt);
				if (body["content"] === "Ambiguous manager response") {
					response.destroy();
					return;
				}
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify(receipt));
			});
		});
		await new Promise<void>((resolve) => manager.listen(0, "127.0.0.1", resolve));
		const address = manager.address();
		if (!address || typeof address === "string") throw new Error("manager did not bind");
		const runtime = new AssistantRuntime(
			services.db.writer,
			new ClaudeCodeAssistantManager({
				url: `http://127.0.0.1:${String(address.port)}`,
				token: "manager-test-token",
				publicConsoleUrl: "http://console.test",
			}),
		);
		const server = await buildServer({ ...services, assistantRuntime: runtime }, true);
		await services.db.admin`
			insert into api_tokens (token_sha256, subject, kind, tiers, lanes)
			values (${sha256(`runtime-user-${randomUUID()}`)}, 'runtime-user', 'human', '["owner"]', '["viewer"]')`;
		const headers = {
			"x-dev-principal": JSON.stringify({
				kind: "human",
				id: "runtime-user",
				tiers: ["owner"],
				lanes: ["viewer"],
				scopes: ["fleet"],
			}),
		};
		const messageId = randomUUID();
		try {
			const whitespace = await server.inject({
				method: "POST",
				url: "/api/v1/assistant/messages",
				headers,
				payload: { id: randomUUID(), message: "   \n\t" },
			});
			expect(whitespace.statusCode).toBe(400);
			const sent = await server.inject({
				method: "POST",
				url: "/api/v1/assistant/messages",
				headers,
				payload: { id: messageId, message: "Arrange a fleet overview." },
			});
			expect(sent.statusCode, sent.body).toBe(200);
			expect(sent.json()).toMatchObject({
				schema_version: 1,
				session_id: "claude-session-runtime-user",
				content: "I can use the tools.",
			});
			expect(toolToken.length).toBeGreaterThan(32);
			const listed = await server.inject({
				method: "POST",
				url: "/api/v1/assistant/mcp",
				headers: { authorization: `Bearer ${toolToken}` },
				payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
			});
			expect(listed.statusCode, listed.body).toBe(200);
			expect(listed.json().result.tools.map((tool: { name: string }) => tool.name)).toEqual([
				"stats.query",
				"viz.render",
				"text.surface",
				"window.arrange",
				"dashboard.manage",
				"context.receive",
				"library.surface",
			]);
			const arranged = await server.inject({
				method: "POST",
				url: "/api/v1/assistant/mcp",
				headers: { authorization: `Bearer ${toolToken}` },
				payload: {
					jsonrpc: "2.0",
					id: 2,
					method: "tools/call",
					params: {
						name: "window.arrange",
						arguments: { ops: [{ verb: "place", panel_index: 0, layout: { x: 0, y: 0 } }] },
					},
				},
			});
			expect(arranged.json().result.isError).not.toBe(true);
			const libraryView = await server.inject({
				method: "POST",
				url: "/api/v1/assistant/mcp",
				headers: { authorization: `Bearer ${toolToken}` },
				payload: {
					jsonrpc: "2.0",
					id: 21,
					method: "tools/call",
					params: { name: "library.surface", arguments: { action: "view", view: "graph" } },
				},
			});
			expect(libraryView.json().result.structuredContent).toMatchObject({
				surface: "library",
				intent: { view: "graph" },
			});
			const missingContextValue = await server.inject({
				method: "POST",
				url: "/api/v1/assistant/mcp",
				headers: { authorization: `Bearer ${toolToken}` },
				payload: {
					jsonrpc: "2.0",
					id: 20,
					method: "tools/call",
					params: { name: "context.receive", arguments: { payload: { element_kind: "bar" } } },
				},
			});
			expect(missingContextValue.json().result.isError).toBe(true);
			const contextId = randomUUID();
			const context = await server.inject({
				method: "POST",
				url: "/api/v1/assistant/context",
				headers,
				payload: {
					id: contextId,
					payload: { element_kind: "bar", field: "host", value: "box-1", datum: { host: "box-1" } },
				},
			});
			expect(context.statusCode, context.body).toBe(200);
			expect(context.json().content).toBe("Context received.");
			const current = await server.inject({
				method: "GET",
				url: "/api/v1/assistant/session",
				headers,
			});
			expect(current.json().session).toMatchObject({
				session_id: "claude-session-runtime-user",
				state: "ready",
				window_layout: { ops: [expect.objectContaining({ verb: "place" })] },
				last_context: { element_kind: "bar", field: "host", value: "box-1" },
			});
			const retry = await server.inject({
				method: "POST",
				url: "/api/v1/assistant/messages",
				headers,
				payload: { id: messageId, message: "Arrange a fleet overview." },
			});
			expect(retry.json()).toEqual(sent.json());
			expect(managerCalls.filter(({ path }) => path.endsWith("/messages"))).toHaveLength(2);
			const contextConflict = await server.inject({
				method: "POST",
				url: "/api/v1/assistant/context",
				headers,
				payload: { id: contextId, payload: { element_kind: "bar", value: "box-2" } },
			});
			expect(contextConflict.statusCode).toBe(409);
			const afterConflict = await server.inject({
				method: "GET",
				url: "/api/v1/assistant/session",
				headers,
			});
			expect(afterConflict.json().session.last_context.value).toBe("box-1");

			const ambiguous = await server.inject({
				method: "POST",
				url: "/api/v1/assistant/messages",
				headers,
				payload: { id: randomUUID(), message: "Ambiguous manager response" },
			});
			expect(ambiguous.statusCode, ambiguous.body).toBe(200);
			expect(ambiguous.json().content).toBe("I can use the tools.");

			await services.db.admin`
				update tiers set default_relations = '["editor"]' where name = 'collaborator'`;
			await services.db.admin`
				insert into grants (subject, relation, object, granted_by)
				values ('tier:collaborator', 'editor', 'fleet', 'test')`;
			await services.db.admin`
				insert into api_tokens (token_sha256, subject, kind, tiers, lanes)
				values (${sha256(`runtime-collaborator-${randomUUID()}`)}, 'runtime-collaborator', 'human', '["collaborator"]', '["viewer"]')`;
			const collaboratorHeaders = {
				"x-dev-principal": JSON.stringify({
					kind: "human",
					id: "runtime-collaborator",
					tiers: ["collaborator"],
					lanes: ["viewer"],
					scopes: ["fleet"],
				}),
			};
			await server.inject({
				method: "POST",
				url: "/api/v1/assistant/messages",
				headers: collaboratorHeaders,
				payload: { id: randomUUID(), message: "Prepare a dashboard suggestion." },
			});
			const collaboratorToken = toolTokens.get("runtime-collaborator");
			expect(collaboratorToken).toBeTruthy();
			const proposedSave = await server.inject({
				method: "POST",
				url: "/api/v1/assistant/mcp",
				headers: { authorization: `Bearer ${String(collaboratorToken)}` },
				payload: {
					jsonrpc: "2.0",
					id: 3,
					method: "tools/call",
					params: {
						name: "dashboard.manage",
						arguments: {
							action: "save",
							dashboard: {
								schema_version: 1,
								id: randomUUID(),
								title: "Must be proposed",
								scope: "fleet",
								panels: [{ schema_version: 2, type: "text", title: "Note", prose: "Review." }],
							},
						},
					},
				},
			});
			expect(proposedSave.json().result).toMatchObject({ isError: true });
			expect(proposedSave.body).toContain("tracker_unavailable");
			const committed = await services.db.admin<{ n: number }[]>`
				select count(*)::int as n from items_min where created_by = 'runtime-collaborator'`;
			expect(committed[0]?.n).toBe(0);
			await services.db
				.admin`update tiers set default_relations = '["viewer"]' where name = 'collaborator'`;
			await services.db.admin`
				delete from grants where subject = 'tier:collaborator' and relation = 'editor' and object = 'fleet'`;

			await services.db
				.admin`update api_tokens set revoked_at = now() where subject = 'runtime-user'`;
			const revoked = await server.inject({
				method: "POST",
				url: "/api/v1/assistant/mcp",
				headers: { authorization: `Bearer ${toolToken}` },
				payload: { jsonrpc: "2.0", id: 4, method: "tools/list" },
			});
			expect(revoked.statusCode).toBe(401);
		} finally {
			await server.close();
			await new Promise<void>((resolve, reject) =>
				manager.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});
});

describe("signal source development mode", () => {
	it("mutes and restores the real append-to-delivery path through the audited named op", async () => {
		const server = await buildServer(services, true);
		const pattern = `test.dev_mode_${randomBytes(4).toString("hex")}`;
		const headers = {
			"x-dev-principal": JSON.stringify({
				kind: "human",
				id: "parker",
				tiers: ["owner"],
				scopes: ["fleet", "user:parker"],
				lanes: ["viewer", "operator"],
			}),
		};
		try {
			await services.db.writer`
				insert into delivery_config
					(owner, scope, channel, target, verified, updated_at, updated_by)
				values ('parker', 'user:parker', 'matrix', '@parker:local', true, now(), 'test')
				on conflict (owner) do update set target = excluded.target, verified = true`;
			const subscription = await services.emit(
				"system:console-api",
				{
					schema_version: 1,
					id: randomUUID(),
					type: "subscription.changed",
					ts: new Date().toISOString(),
					source: { service: "console-api", host: null, agent: null },
					subject: `parker:${pattern}`,
					subject_kind: "other",
					severity: "info",
					scope: "user:parker",
					dimensions: { owner: "parker", pattern, tier: "feed", loud: true },
					meta: {
						retention_class: "audit",
						entity: { schema_version: 1, owner: "parker", pattern, tier: "feed", loud: true },
					},
				},
				300,
			);
			expect(subscription.ok).toBe(true);
			await waitProjected("subscription", `parker:${pattern}`, subscription.seq!);
			const changed = await server.inject({
				method: "POST",
				url: "/api/v1/op",
				headers,
				payload: {
					schema_version: 1,
					id: randomUUID(),
					op: "signal.source_mode",
					args: {
						source_service: "console-api",
						mode: "development",
						note: "test-container work",
					},
					dry_run: false,
				},
			});
			expect(changed.statusCode, changed.body).toBe(200);
			expect(changed.json().result).toMatchObject({
				source_service: "console-api",
				mode: "development",
				updated_by: "parker",
			});
			expect(changed.json().undo).toEqual({
				op: "signal.source_mode",
				args: { source_service: "console-api", mode: "normal" },
			});

			const listed = await server.inject({
				method: "GET",
				url: "/api/v1/signal-sources",
				headers,
			});
			expect(listed.statusCode, listed.body).toBe(200);
			expect(listed.json().items).toContainEqual(
				expect.objectContaining({
					source_service: "console-api",
					mode: "development",
					note: "test-container work",
				}),
			);
			const sendsBefore = deliverySends.length;
			const muted = await services.emit(
				"test:emitter",
				emission({ type: pattern, severity: "p0", subject: "muted development alert" }),
				300,
			);
			expect(muted.ok).toBe(true);
			await services.delivery.drain();
			expect(deliverySends).toHaveLength(sendsBefore);

			const restored = await server.inject({
				method: "POST",
				url: "/api/v1/op",
				headers,
				payload: {
					schema_version: 1,
					id: randomUUID(),
					op: "signal.source_mode",
					args: { source_service: "console-api", mode: "normal" },
					dry_run: false,
				},
			});
			expect(restored.statusCode, restored.body).toBe(200);
			expect(restored.json().undo).toEqual({
				op: "signal.source_mode",
				args: { source_service: "console-api", mode: "development" },
			});
			const delivered = await services.emit(
				"test:emitter",
				emission({ type: pattern, severity: "p0", subject: "restored alert" }),
				300,
			);
			expect(delivered.ok).toBe(true);
			await services.delivery.drain();
			expect(deliverySends.slice(sendsBefore)).toContainEqual(
				expect.objectContaining({
					owner: "parker",
					body: `${pattern} — restored alert`,
				}),
			);

			const concurrentSource = `test-first-write-${randomBytes(4).toString("hex")}`;
			const concurrentChanges = await Promise.all(
				[0, 1].map(() =>
					server.inject({
						method: "POST",
						url: "/api/v1/op",
						headers,
						payload: {
							schema_version: 1,
							id: randomUUID(),
							op: "signal.source_mode",
							args: { source_service: concurrentSource, mode: "development" },
							dry_run: false,
						},
					}),
				),
			);
			expect(concurrentChanges.map((response) => response.statusCode)).toEqual([200, 200]);
			expect(
				concurrentChanges.map((response) => response.json().undo.args.mode).toSorted(),
			).toEqual(["development", "normal"]);
		} finally {
			await server.close();
		}
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
