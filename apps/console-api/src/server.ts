// The HTTP + WS surface (contract §1.1). Fastify with a bearer/dev auth hook that resolves a
// server-stamped Principal, then the four-plane routes. N1a ships Query + Bus + emit + health/me;
// the Command and Library planes land in N1c/N1d.

import websocket from "@fastify/websocket";
import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";

import { buildServices, type Services } from "./app.ts";
import { resolveBearer, devPrincipal, type Principal } from "./auth/principal.ts";
import type { SubscribeSpec } from "./bus/broker.ts";
import { loadEnv } from "./env.ts";
import { runStructured, QueryError, type QueryRequest } from "./query/structured.ts";

declare module "fastify" {
	interface FastifyRequest {
		principal?: Principal;
	}
}

export async function buildServer(services: Services, devAuth: boolean) {
	const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
	await app.register(websocket);

	async function auth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
		const authz = req.headers.authorization;
		if (authz?.startsWith("Bearer ")) {
			const p = await resolveBearer(services.db.admin, authz.slice(7));
			if (p) {
				req.principal = p;
				return;
			}
		}
		if (devAuth) {
			const dev = req.headers["x-dev-principal"];
			if (typeof dev === "string") {
				const p = devPrincipal(dev);
				if (p) {
					req.principal = p;
					return;
				}
			}
		}
		await reply
			.code(401)
			.send({ error: { code: "unauthorized", message: "bearer required", retryable: false } });
	}

	// --- health (unauthenticated) --------------------------------------------------------------
	app.get("/api/v1/health", async () => {
		let lake: "ok" | "down" = "ok";
		try {
			await services.db.admin`select 1`;
		} catch {
			lake = "down";
		}
		return {
			lake,
			seq_head: services.broker.head,
			bridges: [],
			ws_clients: 0,
			matrix_sync_ok_epoch: null,
		};
	});

	// --- me --------------------------------------------------------------------------------------
	app.get("/api/v1/me", { preHandler: auth }, async (req) => {
		const p = req.principal as Principal;
		return {
			schema_version: 1,
			kind: p.kind,
			id: p.id,
			tiers: p.tiers,
			lanes: p.lanes,
			scopes: p.scopes,
			zookie: p.zookie,
		};
	});

	// --- emit ------------------------------------------------------------------------------------
	app.post("/api/v1/emit", { preHandler: auth }, async (req, reply) => {
		const p = req.principal as Principal;
		const bytes = Buffer.byteLength(JSON.stringify(req.body ?? {}));
		const outcome = await services.emit(p.id, req.body, bytes);
		if (!outcome.ok)
			return reply
				.code(outcome.code === "unregistered_producer" ? 403 : 400)
				.send({ error: { code: outcome.code, message: outcome.message, retryable: false } });
		return reply.code(202).send({ seq: outcome.seq, duplicate: outcome.duplicate ?? false });
	});

	app.post("/api/v1/emit/batch", { preHandler: auth }, async (req, reply) => {
		const p = req.principal as Principal;
		const body = req.body;
		if (!Array.isArray(body))
			return reply
				.code(400)
				.send({ error: { code: "invalid_batch", message: "expected array", retryable: false } });
		if (body.length > 500)
			return reply
				.code(400)
				.send({ error: { code: "batch_too_large", message: "max 500", retryable: false } });
		const results = [];
		for (const item of body) {
			const bytes = Buffer.byteLength(JSON.stringify(item));
			const outcome = await services.emit(p.id, item, bytes);
			results.push(
				outcome.ok
					? { seq: outcome.seq, duplicate: outcome.duplicate ?? false }
					: { error: { code: outcome.code, message: outcome.message, retryable: false } },
			);
		}
		return reply.code(202).send({ results });
	});

	// --- query -----------------------------------------------------------------------------------
	app.post("/api/v1/query", { preHandler: auth }, async (req, reply) => {
		const p = req.principal as Principal;
		const body = req.body as QueryRequest;
		if (body?.mode === "sql") {
			if (!p.lanes.includes("operator") && !p.lanes.includes("admin"))
				return reply.code(403).send({
					error: {
						code: "lane_denied",
						message: "sql mode requires operator+",
						retryable: false,
					},
				});
			return reply.code(400).send({
				error: { code: "not_implemented", message: "sql mode lands in N1d", retryable: false },
			});
		}
		try {
			const result = await runStructured(services.db.app, p.scopes, body);
			return result;
		} catch (err) {
			if (err instanceof QueryError)
				return reply
					.code(400)
					.send({ error: { code: err.code, message: err.message, retryable: false } });
			throw err;
		}
	});

	// --- catalog ---------------------------------------------------------------------------------
	app.get("/api/v1/catalog", { preHandler: auth }, async (req) => {
		const p = req.principal as Principal;
		if (p.scopes.length === 0) return { schema_version: 1, items: [] };
		const rows = await services.db.app<{ scopes: string[]; [k: string]: unknown }[]>`
			select type, first_seen, last_emit, dimensions, measures, scopes, emit_count
			from semantic_registry
			where scopes ?| ${services.db.app.array(p.scopes as string[])}
			order by type`;
		// intersect observed scopes with the caller's grant so a viewer can't learn a type was also
		// seen in a scope they lack (sub-agent L3)
		const items = rows.map((r) => ({ ...r, scopes: r.scopes.filter((s) => p.scopes.includes(s)) }));
		return { schema_version: 1, items };
	});

	// --- bus WS ----------------------------------------------------------------------------------
	app.get("/api/v1/bus/ws", { websocket: true }, (socket, req) => {
		let principal: Principal | null = null;
		const authz = req.headers.authorization;
		const connSubs: string[] = [];
		const send = (frame: Record<string, unknown>): void => {
			if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
		};
		const bearer = authz?.startsWith("Bearer ") ? authz.slice(7) : null;
		const ready = (async () => {
			try {
				if (bearer) principal = await resolveBearer(services.db.admin, bearer);
				else if (devAuth && typeof req.headers["x-dev-principal"] === "string")
					principal = devPrincipal(req.headers["x-dev-principal"]);
			} catch {
				principal = null;
			}
			if (!principal) {
				send({
					schema_version: 1,
					kind: "ack",
					sub_id: "*",
					replay_through_seq: 0,
					error: { code: "unauthorized", message: "bearer required", retryable: false },
				});
				socket.close();
			}
		})();

		// Re-fence live subscriptions on grant/token change (contract §4.1; sub-agent M1). Every 30s
		// re-resolve the bearer: a revoked token closes the socket; narrowed scopes drop the affected
		// subs (the client resyncs). Dev-header connections are not re-fenced (test-only).
		const revalidateTimer = bearer
			? setInterval(() => {
					void (async () => {
						try {
							const fresh = await resolveBearer(services.db.admin, bearer);
							if (!fresh) {
								for (const id of connSubs) services.broker.unsubscribe(id);
								socket.close();
								return;
							}
							principal = fresh;
							services.broker.revalidateScopes(connSubs, fresh.scopes);
						} catch {
							/* transient DB blip: keep the connection, retry next tick */
						}
					})();
				}, 30000)
			: null;
		if (revalidateTimer) revalidateTimer.unref();

		socket.on("message", (data: Buffer) => {
			void (async () => {
				await ready;
				if (!principal) return;
				let msg: {
					action?: string;
					sub_id?: string;
					pattern?: string;
					filter?: SubscribeSpec["filter"];
					since?: number;
				};
				try {
					msg = JSON.parse(data.toString()) as typeof msg;
				} catch {
					send({
						schema_version: 1,
						kind: "ack",
						sub_id: "?",
						replay_through_seq: services.broker.head,
						error: { code: "bad_frame", message: "invalid json", retryable: false },
					});
					return;
				}
				if (msg.action === "subscribe" && msg.sub_id && msg.pattern) {
					const spec: SubscribeSpec = {
						subId: msg.sub_id,
						pattern: msg.pattern,
						filter: msg.filter,
						since: msg.since,
						scopes: principal.scopes,
					};
					connSubs.push(msg.sub_id);
					await services.broker.subscribe(spec, send);
				} else if (msg.action === "unsubscribe" && msg.sub_id) {
					services.broker.unsubscribe(msg.sub_id);
				}
			})();
		});
		socket.on("close", () => {
			if (revalidateTimer) clearInterval(revalidateTimer);
			for (const id of connSubs) services.broker.unsubscribe(id);
		});
	});

	return app;
}

// entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
	const env = loadEnv();
	const services = await buildServices(env);
	const server = await buildServer(services, env.devAuth);
	await server.listen({ host: env.host, port: env.port });
	process.stdout.write(`console-api listening on ${env.host}:${String(env.port)}\n`);
}
