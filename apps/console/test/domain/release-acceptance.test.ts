import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { promisify } from "node:util";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildServices, type Services } from "../../src/lib/server/domain/substrate.ts";
import type { AssistantCompiler } from "../../src/lib/server/domain/assistant/compiler.ts";
import { AssistantRuntime, ClaudeCodeAssistantManager } from "../../src/lib/server/domain/assistant/runtime.ts";
import type { BetterAuthSessionVerifier } from "../../src/lib/server/domain/auth/session.ts";
import { migrate } from "../../src/lib/server/domain/db/migrate.ts";
import { seedBootstrap } from "../../src/lib/server/domain/db/seed.ts";
import type { Emission } from "../../src/lib/server/domain/emission.ts";
import { buildServer } from "../../src/lib/server/domain/server.ts";

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
	const name = `console-release-acceptance-${randomBytes(6).toString("hex")}`;
	const adminPassword = "test-admin-password";
	const appPassword = "test-app-password";
	const roPassword = "test-ro-password";
	const writerPassword = "test-writer-password";
	await exec("docker", [
		"run",
		"-d",
		"--name",
		name,
		"-e",
		`POSTGRES_PASSWORD=${adminPassword}`,
		"-p",
		"0:5432",
		"timescale/timescaledb:latest-pg16",
	]);
	const { stdout } = await exec("docker", ["port", name, "5432/tcp"]);
	const port = Number(stdout.trim().split(":").pop());
	const base = `127.0.0.1:${String(port)}/postgres`;
	const adminUrl = `postgres://postgres:${adminPassword}@${base}`;
	const deadline = Date.now() + 90_000;
	let readyProbes = 0;
	for (;;) {
		const probe = postgres(adminUrl, {
			max: 1,
			connect_timeout: 3,
			idle_timeout: 1,
			onnotice: () => {},
		});
		try {
			await probe`select 1`;
			readyProbes += 1;
		} catch {
			readyProbes = 0;
		} finally {
			await probe.end({ timeout: 2 }).catch(() => undefined);
		}
		if (readyProbes >= 2) break;
		if (Date.now() > deadline) throw new Error("release-acceptance database never became ready");
		await new Promise((resolve) => setTimeout(resolve, 750));
	}
	return {
		adminUrl,
		appUrl: `postgres://console_app:${appPassword}@${base}`,
		roUrl: `postgres://console_ro:${roPassword}@${base}`,
		writerUrl: `postgres://console_writer:${writerPassword}@${base}`,
		appPassword,
		roPassword,
		writerPassword,
		async stop() {
			await exec("docker", ["rm", "-f", name]).catch(() => undefined);
		},
	};
}

const consoleOrigin = "https://console.release.test";
const alphaScope = "user:release-alpha";
const betaScope = "user:release-beta";
const statisticType = `release.acceptance_${randomBytes(5).toString("hex")}`;

function browserHeaders(username: "release-alpha" | "release-beta") {
	return {
		origin: consoleOrigin,
		cookie: `__Host-console.session_token=session-${username}`,
	};
}

function event(scope: string, marker: string, subject = marker): Emission {
	return {
		schema_version: 1,
		id: randomUUID(),
		type: statisticType,
		ts: new Date().toISOString(),
		source: { service: "console-api", host: null, agent: null },
		subject,
		subject_kind: "other",
		severity: "info",
		scope,
		dimensions: { marker },
		measures: { value: marker === "alpha" ? 11 : 29 },
	};
}

let temp: TempDb;
let services: Services;

beforeAll(async () => {
	temp = await startTempDb();
	const admin = postgres(temp.adminUrl, { onnotice: () => {} });
	await migrate(admin, {
		appPassword: temp.appPassword,
		roPassword: temp.roPassword,
		writerPassword: temp.writerPassword,
	});
	await seedBootstrap(admin);

	// The release principals intentionally receive no tier-wide fleet grant. Their only readable
	// scopes are the two explicit, disjoint user scopes below.
	await admin`delete from grants where subject = 'tier:owner'`;
	await admin`insert into grants (subject, relation, object, granted_by) values
		('release-alpha', 'owner', ${alphaScope}, 'release-acceptance'),
		('release-beta', 'owner', ${betaScope}, 'release-acceptance'),
		('release:emitter', 'editor', ${alphaScope}, 'release-acceptance'),
		('release:emitter', 'editor', ${betaScope}, 'release-acceptance')`;
	await admin`insert into producer_registrations
		(subject, allowed_services, allowed_prefixes, allowed_scopes, max_severity)
		values ('release:emitter', '["console-api"]', '["release", "attention"]',
			'["user:release-alpha", "user:release-beta"]', 'danger')`;
	await admin`insert into library_items (id, entity_id, kind, title, scope, project, status)
		values ('release-alpha-library', 'release-alpha-library', 'doc', 'Alpha isolation marker',
			${alphaScope}, 'release', 'verified-shared'),
		       ('release-beta-library', 'release-beta-library', 'doc', 'Beta isolation marker',
			${betaScope}, 'release', 'verified-shared')`;
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
}, 120_000);

afterAll(async () => {
	await services?.close();
	await temp?.stop();
});

describe("BR-032 hermetic release acceptance", () => {
	it("spans two trusted humans without leaking reads, bus events, operations, or artifacts", async () => {
		const activeSessions = new Map([
			[
				"session-release-alpha",
				{
					username: "release-alpha",
					groups: ["authentik Admins", "term_admin"],
					subject: "oidc-alpha",
					sessionId: "session-release-alpha",
				},
			],
			[
				"session-release-beta",
				{
					username: "release-beta",
					groups: ["admin"],
					subject: "oidc-beta",
					sessionId: "session-release-beta",
				},
			],
		]);
		const betterAuth: BetterAuthSessionVerifier = {
			consoleOrigin,
			async getIdentity(headers) {
				const token = /session-(release-(?:alpha|beta))/.exec(String(headers.cookie ?? ""))?.[0];
				return token ? (activeSessions.get(token) ?? null) : null;
			},
			async getIdentityBySessionId(sessionId) {
				return activeSessions.get(sessionId) ?? null;
			},
			async close() {},
		};
		const managerSessions = new Map<string, string>();
		const toolTokens = new Map<string, string>();
		const manager = createHttpServer((request, response) => {
			let text = "";
			request.setEncoding("utf8");
			request.on("data", (chunk) => {
				text += chunk;
			});
			request.on("end", () => {
				const body = JSON.parse(text) as Record<string, unknown>;
				response.writeHead(200, { "content-type": "application/json" });
				if (request.url === "/v1/sessions/ensure") {
					const externalId = String(body["external_session_id"]);
					const principalId = String((body["principal"] as { id?: unknown }).id);
					const expected = managerSessions.get(externalId);
					if (expected && expected !== principalId) {
						response.writeHead(409).end();
						return;
					}
					managerSessions.set(externalId, principalId);
					toolTokens.set(
						principalId,
						String((body["mcp"] as { bearer_token?: unknown }).bearer_token),
					);
					response.end(JSON.stringify({ session_id: `release-${principalId}-session` }));
					return;
				}
				response.end(
					JSON.stringify({
						message_id: `reply-${String(body["message_id"])}`,
						content: "Context accepted for the scoped release session.",
						tool_results: [],
					}),
				);
			});
		});
		await new Promise<void>((resolve, reject) => {
			manager.once("error", reject);
			manager.listen(0, "127.0.0.1", resolve);
		});
		const managerAddress = manager.address();
		if (!managerAddress || typeof managerAddress === "string")
			throw new Error("release-acceptance manager did not bind");
		const assistantRuntime = new AssistantRuntime(
			services.db.writer,
			new ClaudeCodeAssistantManager({
				url: `http://127.0.0.1:${String(managerAddress.port)}`,
				token: "release-acceptance-manager-token",
				publicConsoleUrl: consoleOrigin,
			}),
		);
		const compiler: AssistantCompiler = {
			async compile() {
				return {
					feasible: true,
					request: {
						schema_version: 1,
						mode: "structured",
						from: statisticType,
						select: [{ field: "value", agg: "avg", as: "average_value" }],
						group_by: ["marker"],
						limit: 20,
					},
					panel: {
						type: "bar",
						title: "Release acceptance by principal",
						encoding: { x: "marker", y: "average_value" },
					},
				};
			},
		};
		const server = await buildServer(
			{ ...services, assistant: compiler, assistantRuntime },
			false,
			undefined,
			undefined,
			betterAuth,
		);
		const alphaHeaders = browserHeaders("release-alpha");
		const betaHeaders = browserHeaders("release-beta");
		try {
			// Trusted human login resolves current ReBAC state rather than accepting client scopes.
			const [alphaMe, betaMe] = await Promise.all([
				server.inject({ method: "GET", url: "/api/v1/me", headers: alphaHeaders }),
				server.inject({ method: "GET", url: "/api/v1/me", headers: betaHeaders }),
			]);
			expect(alphaMe.statusCode, alphaMe.body).toBe(200);
			expect(betaMe.statusCode, betaMe.body).toBe(200);
			expect(alphaMe.json()).toMatchObject({
				id: "release-alpha",
				lanes: ["viewer", "editor", "operator", "admin", "term_admin"],
				scopes: [alphaScope],
			});
			expect(betaMe.json().scopes).toEqual([betaScope]);
			activeSessions.set("session-release-alpha", {
				username: "release-alpha",
				groups: ["authentik Admins"],
				subject: "oidc-alpha",
				sessionId: "session-release-alpha",
			});
			const alphaAfterTierRemoval = await server.inject({
				method: "GET",
				url: "/api/v1/me",
				headers: alphaHeaders,
			});
			expect(alphaAfterTierRemoval.json().lanes).toEqual(["viewer", "editor", "operator", "admin"]);

			expect(await services.emit("release:emitter", event(alphaScope, "alpha"), 400)).toMatchObject(
				{
					ok: true,
				},
			);
			expect(await services.emit("release:emitter", event(betaScope, "beta"), 400)).toMatchObject({
				ok: true,
			});

			const query = {
				schema_version: 1,
				mode: "structured",
				from: statisticType,
				select: [{ field: "seq", agg: "count", as: "events" }],
				group_by: ["marker"],
				limit: 20,
			};
			const [alphaQuery, betaQuery] = await Promise.all([
				server.inject({
					method: "POST",
					url: "/api/v1/query",
					headers: alphaHeaders,
					payload: query,
				}),
				server.inject({
					method: "POST",
					url: "/api/v1/query",
					headers: betaHeaders,
					payload: query,
				}),
			]);
			expect(alphaQuery.statusCode, alphaQuery.body).toBe(200);
			expect(betaQuery.statusCode, betaQuery.body).toBe(200);
			expect(alphaQuery.json().rows).toEqual([["alpha", 1]]);
			expect(betaQuery.json().rows).toEqual([["beta", 1]]);

			// Both Better Auth sessions concurrently create independently keyed manager sessions. The
			// same message id is valid in each principal ledger and cannot collide across users.
			const sharedMessageId = randomUUID();
			const [alphaAssistant, betaAssistant] = await Promise.all([
				server.inject({
					method: "POST",
					url: "/api/v1/assistant/messages",
					headers: alphaHeaders,
					payload: { id: sharedMessageId, message: "Read only my release data." },
				}),
				server.inject({
					method: "POST",
					url: "/api/v1/assistant/messages",
					headers: betaHeaders,
					payload: { id: sharedMessageId, message: "Read only my release data." },
				}),
			]);
			expect(alphaAssistant.statusCode, alphaAssistant.body).toBe(200);
			expect(betaAssistant.statusCode, betaAssistant.body).toBe(200);
			expect(alphaAssistant.json().session_id).toBe("release-release-alpha-session");
			expect(betaAssistant.json().session_id).toBe("release-release-beta-session");
			expect(managerSessions.size).toBe(2);
			expect(toolTokens.get("release-alpha")).not.toBe(toolTokens.get("release-beta"));
			await Promise.all([
				server.inject({
					method: "POST",
					url: "/api/v1/assistant/context",
					headers: alphaHeaders,
					payload: {
						id: randomUUID(),
						payload: { element_kind: "row", value: "alpha-only" },
					},
				}),
				server.inject({
					method: "POST",
					url: "/api/v1/assistant/context",
					headers: betaHeaders,
					payload: {
						id: randomUUID(),
						payload: { element_kind: "row", value: "beta-only" },
					},
				}),
			]);
			const assistantState = await services.db.admin<
				{ principal_id: string; last_context: { element_kind: string; value: string } }[]
			>`select principal_id, last_context from assistant_sessions
			  where principal_id in ('release-alpha', 'release-beta') order by principal_id`;
			expect(assistantState).toEqual([
				{
					principal_id: "release-alpha",
					last_context: { element_kind: "row", value: "alpha-only" },
				},
				{
					principal_id: "release-beta",
					last_context: { element_kind: "row", value: "beta-only" },
				},
			]);

			const mcpQuery = (token: string) =>
				server.inject({
					method: "POST",
					url: "/api/v1/assistant/mcp",
					headers: { authorization: `Bearer ${token}` },
					payload: {
						jsonrpc: "2.0",
						id: 1,
						method: "tools/call",
						params: { name: "stats.query", arguments: query },
					},
				});
			const [alphaMcp, betaMcp] = await Promise.all([
				mcpQuery(toolTokens.get("release-alpha") ?? ""),
				mcpQuery(toolTokens.get("release-beta") ?? ""),
			]);
			expect(alphaMcp.statusCode, alphaMcp.body).toBe(200);
			expect(betaMcp.statusCode, betaMcp.body).toBe(200);
			expect(alphaMcp.json().result.structuredContent.rows).toEqual([["alpha", 1]]);
			expect(betaMcp.json().result.structuredContent.rows).toEqual([["beta", 1]]);
			const libraryMcp = await Promise.all(
				[toolTokens.get("release-alpha"), toolTokens.get("release-beta")].map((token, id) =>
					server.inject({
						method: "POST",
						url: "/api/v1/assistant/mcp",
						headers: { authorization: `Bearer ${token ?? ""}` },
						payload: {
							jsonrpc: "2.0",
							id: id + 10,
							method: "tools/call",
							params: {
								name: "library.surface",
								arguments: { action: "search", query: "isolation marker", limit: 20 },
							},
						},
					}),
				),
			);
			expect(libraryMcp.every((response) => response.statusCode === 200)).toBe(true);
			expect(JSON.stringify(libraryMcp[0]?.json())).toContain("Alpha isolation marker");
			expect(JSON.stringify(libraryMcp[0]?.json())).not.toContain("Beta isolation marker");
			expect(JSON.stringify(libraryMcp[1]?.json())).toContain("Beta isolation marker");
			expect(JSON.stringify(libraryMcp[1]?.json())).not.toContain("Alpha isolation marker");

			// Query references are capabilities only within every originating scope.
			const forbiddenQuery = await server.inject({
				method: "GET",
				url: `/api/v1/query/${String(betaQuery.json().query_ref)}`,
				headers: alphaHeaders,
			});
			expect(forbiddenQuery.statusCode).toBe(404);
			expect(forbiddenQuery.json().error.code).toBe("query_not_found");

			// A real authenticated browser WebSocket receives only its scope. Grant changes later in
			// this workflow must actively re-fence the existing subscription.
			const socket = await server.injectWS("/api/v1/bus/ws", {
				headers: alphaHeaders,
				rawHeaders: Object.entries(alphaHeaders).flatMap(([name, value]) => [name, value]),
				socket: { remoteAddress: "127.0.0.1" },
			});
			const frames: Record<string, unknown>[] = [];
			socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
			socket.send(
				JSON.stringify({
					schema_version: 1,
					action: "subscribe",
					sub_id: "release",
					pattern: "**",
				}),
			);
			await expect
				.poll(() => frames.some((frame) => frame["kind"] === "ack"), { timeout: 2_000 })
				.toBe(true);
			await services.emit("release:emitter", event(betaScope, "beta-live", "beta-live"), 400);
			await services.emit("release:emitter", event(alphaScope, "alpha-live", "alpha-live"), 400);
			await expect
				.poll(
					() =>
						frames.some(
							(frame) =>
								frame["kind"] === "event" &&
								(frame["emission"] as { subject?: string } | undefined)?.subject === "alpha-live",
						),
					{ timeout: 2_000 },
				)
				.toBe(true);
			expect(JSON.stringify(frames)).not.toContain("beta-live");
			socket.terminate();

			// The allowed mutation reaches the real assistant-runtime adapter and commits both intent
			// and outcome audit records. A foreign-scope operation is rejected before execution.
			const allowedOpId = randomUUID();
			const allowedOp = await server.inject({
				method: "POST",
				url: "/api/v1/op",
				headers: alphaHeaders,
				payload: {
					schema_version: 1,
					id: allowedOpId,
					op: "context.receive",
					args: {
						payload: { element_kind: "bar", field: "marker", value: "alpha" },
					},
					dry_run: false,
				},
			});
			expect(allowedOp.statusCode, allowedOp.body).toBe(200);
			expect(allowedOp.json()).toMatchObject({
				ok: true,
				status: "applied",
				result: {
					session_id: "release-release-alpha-session",
					content: "Context accepted for the scoped release session.",
				},
			});
			const audit = await services.db.admin<
				{ type: string; dimensions: Record<string, unknown> }[]
			>`
				select type, dimensions from events where id = ${allowedOpId}
				   or meta->>'in_reply_to' = ${allowedOpId} order by seq`;
			expect(audit.map(({ type }) => type)).toEqual(["audit.op.intent", "audit.op.outcome"]);
			expect(audit.every(({ dimensions }) => dimensions["principal"] === "release-alpha")).toBe(
				true,
			);

			const attentionId = `attention-${randomBytes(6).toString("hex")}`;
			await services.emit(
				"release:emitter",
				{ ...event(alphaScope, "alpha-attention", attentionId), type: "attention.opened" },
				400,
			);
			const deniedOp = await server.inject({
				method: "POST",
				url: "/api/v1/op",
				headers: betaHeaders,
				payload: {
					schema_version: 1,
					id: randomUUID(),
					op: "attention.ack",
					args: { id: attentionId },
					dry_run: false,
				},
			});
			expect(deniedOp.statusCode).toBe(403);
			expect(deniedOp.json().error.code).toBe("scope_denied");

			// Ask -> render -> save exercises the data contract consumed by the Svelte UI.
			const asked = await server.inject({
				method: "POST",
				url: "/api/v1/ask",
				headers: alphaHeaders,
				payload: { question: "Show my release acceptance value by principal." },
			});
			expect(asked.statusCode, asked.body).toBe(200);
			expect(asked.json()).toMatchObject({
				status: "answered",
				panel: { schema_version: 2, type: "bar", title: "Release acceptance by principal" },
			});
			expect(asked.json().result.rows).toContainEqual(["alpha", 11]);
			expect(asked.json().result.rows).toContainEqual(["alpha-live", 29]);
			expect(JSON.stringify(asked.json().result.rows)).not.toContain("beta");
			const rendered = await server.inject({
				method: "POST",
				url: "/api/v1/render",
				headers: alphaHeaders,
				payload: { query_ref: asked.json().result.query_ref, panel: asked.json().panel },
			});
			expect(rendered.statusCode, rendered.body).toBe(200);
			expect(rendered.json()).toMatchObject({
				panel: { type: "bar" },
				render: { data_query_ref: expect.stringMatching(/^q_/) },
			});
			expect(rendered.json().result.rows).toEqual(asked.json().result.rows);

			const saved = await server.inject({
				method: "POST",
				url: "/api/v1/dashboards",
				headers: alphaHeaders,
				payload: {
					schema_version: 1,
					id: randomUUID(),
					title: "Private release proof",
					scope: alphaScope,
					panels: [asked.json().panel],
				},
			});
			expect(saved.statusCode, saved.body).toBe(200);
			const dashboardId = String(saved.json().id);
			const hiddenArtifact = await server.inject({
				method: "GET",
				url: `/api/v1/dashboards/${dashboardId}`,
				headers: betaHeaders,
			});
			expect(hiddenArtifact.statusCode).toBe(404);

			// Item-level sharing reveals the shell, not the author's data scope. The UI receives an
			// explicit refusal panel because the recipient cannot execute the author's query.
			const shared = await server.inject({
				method: "POST",
				url: "/api/v1/grants",
				headers: alphaHeaders,
				payload: {
					schema_version: 1,
					id: randomUUID(),
					action: "grant",
					subject: "release-beta",
					relation: "viewer",
					object: `item:${dashboardId}`,
				},
			});
			expect(shared.statusCode, shared.body).toBe(200);
			const betaAfterShare = await server.inject({
				method: "GET",
				url: "/api/v1/me",
				headers: betaHeaders,
			});
			expect(betaAfterShare.json().scopes).toEqual([`item:${dashboardId}`, betaScope]);
			expect(betaAfterShare.json().scopes).not.toContain(alphaScope);
			const sharedArtifact = await server.inject({
				method: "GET",
				url: `/api/v1/dashboards/${dashboardId}`,
				headers: betaHeaders,
			});
			expect(sharedArtifact.statusCode, sharedArtifact.body).toBe(200);
			expect(sharedArtifact.json().materialized_panels[0]).toMatchObject({
				panel: {
					type: "refusal",
					refusal: { reason: "This panel's query is not visible in the current caller scope." },
				},
				result: null,
			});
			expect(JSON.stringify(sharedArtifact.json())).not.toContain('"alpha",11');

			// Open a fresh subscription after the unrelated item-share grant change so this assertion
			// proves that narrowing Alpha's readable scope itself triggers the re-fence.
			const scopeFenceSocket = await server.injectWS("/api/v1/bus/ws", {
				headers: alphaHeaders,
				rawHeaders: Object.entries(alphaHeaders).flatMap(([name, value]) => [name, value]),
				socket: { remoteAddress: "127.0.0.1" },
			});
			const scopeFenceFrames: Record<string, unknown>[] = [];
			scopeFenceSocket.on("message", (data) => scopeFenceFrames.push(JSON.parse(data.toString())));
			scopeFenceSocket.send(
				JSON.stringify({
					schema_version: 1,
					action: "subscribe",
					sub_id: "release-scope-fence",
					pattern: "**",
				}),
			);
			await expect
				.poll(() => scopeFenceFrames.some((frame) => frame["kind"] === "ack"), {
					timeout: 2_000,
				})
				.toBe(true);
			const revoked = await server.inject({
				method: "POST",
				url: "/api/v1/grants",
				headers: alphaHeaders,
				payload: {
					schema_version: 1,
					id: randomUUID(),
					action: "revoke",
					subject: "release-alpha",
					relation: "owner",
					object: alphaScope,
				},
			});
			expect(revoked.statusCode, revoked.body).toBe(200);
			await expect
				.poll(
					() =>
						scopeFenceFrames.some(
							(frame) =>
								frame["kind"] === "resync_required" && frame["message"] === "grant changed",
						),
					{ timeout: 2_000 },
				)
				.toBe(true);

			// The already-minted manager token is re-resolved after revocation, so its next MCP read
			// cannot retain Alpha's former RLS scope.
			const alphaAfterRevoke = await mcpQuery(toolTokens.get("release-alpha") ?? "");
			expect(alphaAfterRevoke.statusCode, alphaAfterRevoke.body).toBe(200);
			expect(alphaAfterRevoke.json().result).toMatchObject({ isError: true });
			expect(alphaAfterRevoke.body).not.toContain("alpha-only");
			const alphaLibraryAfterRevoke = await server.inject({
				method: "POST",
				url: "/api/v1/assistant/mcp",
				headers: { authorization: `Bearer ${toolTokens.get("release-alpha") ?? ""}` },
				payload: {
					jsonrpc: "2.0",
					id: 99,
					method: "tools/call",
					params: {
						name: "library.surface",
						arguments: { action: "search", query: "Alpha isolation marker", limit: 20 },
					},
				},
			});
			expect(alphaLibraryAfterRevoke.json().result.structuredContent.data.items).toEqual([]);

			// Logout invalidates the originating Better Auth session binding immediately. Presenting
			// Beta's cookie after the swap resolves Beta, never Alpha, and Beta's old MCP token dies.
			activeSessions.delete("session-release-beta");
			const loggedOutMcp = await mcpQuery(toolTokens.get("release-beta") ?? "");
			expect(loggedOutMcp.statusCode).toBe(401);
			const loggedOutMe = await server.inject({
				method: "GET",
				url: "/api/v1/me",
				headers: betaHeaders,
			});
			expect(loggedOutMe.statusCode).toBe(401);
			scopeFenceSocket.terminate();
		} finally {
			await server.close();
			await new Promise<void>((resolve) => manager.close(() => resolve()));
		}
	}, 60_000);
});
