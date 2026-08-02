import { Effect } from "effect";

import type { Principal } from "../auth/principal.ts";
import type { GrantRelation } from "../auth/tiers.ts";
import { edge } from "../edge.ts";
import { readEntity } from "../reads/entities.ts";
import type { Services } from "../substrate.ts";

export interface TerminalTarget {
	readonly host: string;
	readonly tmuxSession: string;
	readonly paneId: string;
}

export interface TerminalAdapter {
	health(): Promise<boolean>;
	capture(target: TerminalTarget, scrollbackLines: number): Promise<Buffer>;
	input(target: TerminalTarget, data: Buffer): Promise<void>;
}

export interface TerminalAccess {
	readonly audit_writable: true;
	readonly pty_live: boolean;
	readonly audit_seq: number;
}

export interface TerminalSnapshot {
	readonly schema_version: 1;
	readonly stream_id: string;
	readonly seq: number;
	readonly audit_seq?: number;
	readonly data_b64: string;
}

export interface TerminalSession {
	readonly principalId: string;
	readonly target: TerminalTarget;
	readonly writable: boolean;
	attached: boolean;
	closed: boolean;
	seq: number;
	timer: ReturnType<typeof setTimeout> | null;
	end: () => void;
}

export class TerminalDomainError extends Error {
	readonly _tag = "TerminalDomainError";
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly retryable: boolean,
	) {
		super(message);
	}
}

/**
 * The only recoverable failure the terminal domain models: an authz denial, a gate/audit outage, or
 * a PTY capture fault.
 */
const isTerminalDomainError = (error: unknown): error is TerminalDomainError =>
	error instanceof TerminalDomainError;

export class UnavailableTerminalAdapter implements TerminalAdapter {
	health(): Promise<boolean> {
		return Promise.resolve(false);
	}

	capture(_target: TerminalTarget, _scrollbackLines: number): Promise<Buffer> {
		return Promise.reject(new Error("PTY adapter is not configured"));
	}

	input(_target: TerminalTarget, _data: Buffer): Promise<void> {
		return Promise.reject(new Error("PTY adapter is not configured"));
	}
}

const relationRank: Record<GrantRelation, number> = { viewer: 0, operator: 1, editor: 1, owner: 2 };

// The fleet-owner gate check: the pg grants query is the one external edge. Its inability to
// answer is a caller-retryable 503 (the terminal gate is unavailable), not a defect — a would-be
// operator must be told to retry rather than see an opaque crash.
function hasFleetOwnerGrant(
	services: Services,
	principal: Principal,
): Effect.Effect<boolean, TerminalDomainError> {
	return edge(isTerminalDomainError, async () => {
		const subjects = [principal.id, ...principal.tiers.map((tier) => `tier:${tier}`)];
		try {
			const rows = await services.db.admin<{ relation: GrantRelation }[]>`
				select relation from grants where subject = any(${services.db.admin.array(subjects)})
				  and object = 'fleet' and condition is null and valid_at <= now()
				  and (invalid_at is null or invalid_at > now())`;
			return rows.some((row) => relationRank[row.relation] >= relationRank.owner);
		} catch {
			throw new TerminalDomainError(503, "terminal_unavailable", "terminal gate unavailable", true);
		}
	});
}

// The PTY adapter is a true external edge. A capture fault is a caller-retryable 502 in the terminal
// error channel (the remote surfaces it as BadGateway); anything else the adapter throws is an
// infrastructure defect. Translating at the edge keeps `edge`'s guard honest.
function captureSnapshot(
	adapter: TerminalAdapter,
	target: TerminalTarget,
	scrollbackLines: number,
): Effect.Effect<Buffer, TerminalDomainError> {
	return edge(isTerminalDomainError, async () => {
		try {
			return await adapter.capture(target, scrollbackLines);
		} catch {
			throw new TerminalDomainError(502, "pty_capture_failed", "terminal capture failed", true);
		}
	});
}

export class TerminalService {
	readonly sessions = new Map<string, TerminalSession>();

	constructor(
		readonly services: Services,
		readonly adapter: TerminalAdapter = new UnavailableTerminalAdapter(),
	) {}

	authorize(principal: Principal): Effect.Effect<void, TerminalDomainError> {
		const services = this.services;
		return Effect.gen(function* () {
			if (principal.kind !== "human")
				return yield* Effect.fail(
					new TerminalDomainError(403, "term_denied", "human principal required", false),
				);
			if (!principal.lanes.includes("term_admin"))
				return yield* Effect.fail(
					new TerminalDomainError(403, "term_denied", "term_admin lane required", false),
				);
			const owner = yield* hasFleetOwnerGrant(services, principal);
			if (!owner)
				return yield* Effect.fail(
					new TerminalDomainError(403, "term_denied", "owner relation required on fleet", false),
				);
		});
	}

	audit(
		principal: Principal,
		action: "access" | "watch" | "attach" | "input" | "detach" | "denied",
		target: TerminalTarget | null,
		streamId: string | null,
		reason: string | null = null,
	): Effect.Effect<number, TerminalDomainError> {
		const emission = {
			schema_version: 1,
			id: crypto.randomUUID(),
			type: `term.${action}`,
			ts: new Date().toISOString(),
			source: { service: "console-api", host: null, agent: null },
			subject: streamId ? `term-stream:${streamId}` : "terminal",
			subject_kind: "other",
			severity: action === "denied" ? "danger" : "info",
			scope: "fleet",
			dimensions: {
				action,
				principal: principal.id,
				...(target
					? { host: target.host, tmux_session: target.tmuxSession, pane_id: target.paneId }
					: {}),
				...(streamId ? { stream_id: streamId } : {}),
				...(reason ? { reason } : {}),
			},
			meta: { retention_class: "audit" },
		};
		return edge(isTerminalDomainError, async () => {
			try {
				return await this.services.emit(
					"system:console-api",
					emission,
					Buffer.byteLength(JSON.stringify(emission)),
				);
			} catch {
				throw new TerminalDomainError(
					503,
					"audit_unavailable",
					"terminal audit write could not be verified",
					true,
				);
			}
		}).pipe(
			Effect.flatMap((outcome) =>
				outcome.ok && outcome.seq !== undefined
					? Effect.succeed(outcome.seq)
					: Effect.fail(
							new TerminalDomainError(
								503,
								"audit_unavailable",
								"terminal audit write could not be verified",
								true,
							),
						),
			),
		);
	}
	access(principal: Principal): Effect.Effect<TerminalAccess, TerminalDomainError> {
		const authorize = this.authorize.bind(this);
		const audit = this.audit.bind(this);
		const adapter = this.adapter;
		return Effect.gen(function* () {
			yield* authorize(principal).pipe(
				Effect.catch((denial: TerminalDomainError) =>
					audit(principal, "denied", null, null, denial.message).pipe(
						Effect.flatMap(() => Effect.fail(denial)),
					),
				),
			);
			const auditSeq = yield* audit(principal, "access", null, null);
			const ptyLive = yield* Effect.promise(() => adapter.health());
			return { audit_writable: true, pty_live: ptyLive, audit_seq: auditSeq };
		});
	}

	visible(principal: Principal, target: TerminalTarget): Effect.Effect<boolean> {
		const services = this.services;
		return Effect.gen(function* () {
			const heartbeats = yield* readEntity(services.db.app, principal.scopes, "heartbeat", {
				limit: 1000,
			});
			return heartbeats.items.some(
				(item) =>
					item["host"] === target.host &&
					item["tmux_session"] === target.tmuxSession &&
					item["pane_id"] === target.paneId,
			);
		});
	}

	openPeek(
		principal: Principal,
		target: TerminalTarget,
		scrollbackLines: number,
	): Effect.Effect<TerminalSnapshot, TerminalDomainError> {
		const authorize = this.authorize.bind(this);
		const audit = this.audit.bind(this);
		const visibleTarget = this.visible.bind(this);
		const create = this.create.bind(this);
		const close = this.close.bind(this);
		const adapter = this.adapter;
		return Effect.gen(function* () {
			yield* authorize(principal).pipe(
				Effect.catch((denial: TerminalDomainError) =>
					audit(principal, "denied", null, null, denial.message).pipe(
						Effect.flatMap(() => Effect.fail(denial)),
					),
				),
			);
			const live = yield* Effect.promise(() => adapter.health());
			if (!live)
				return yield* Effect.fail(
					new TerminalDomainError(503, "pty_unavailable", "PTY adapter unavailable", true),
				);
			const visible = yield* visibleTarget(principal, target);
			if (!visible)
				return yield* Effect.fail(
					new TerminalDomainError(
						404,
						"pane_not_visible",
						"resident terminal pane is not visible",
						false,
					),
				);
			const streamId = crypto.randomUUID();
			const auditSeq = yield* audit(principal, "watch", target, streamId);
			const session = create(principal, target, streamId, false);
			session.timer = setTimeout(() => {
				close(streamId);
			}, 30_000);
			session.timer.unref();
			const snapshot = yield* captureSnapshot(adapter, target, scrollbackLines).pipe(
				Effect.tapError(() =>
					Effect.sync(() => {
						close(streamId);
					}),
				),
			);
			session.seq += 1;
			return {
				schema_version: 1,
				stream_id: streamId,
				seq: session.seq,
				audit_seq: auditSeq,
				data_b64: snapshot.toString("base64"),
			};
		});
	}

	pollPeek(
		principal: Principal,
		streamId: string,
	): Effect.Effect<TerminalSnapshot, TerminalDomainError> {
		const owned = this.owned.bind(this);
		const close = this.close.bind(this);
		const adapter = this.adapter;
		return Effect.gen(function* () {
			const session = yield* owned(principal, streamId);
			if (session.timer) clearTimeout(session.timer);
			session.timer = setTimeout(() => {
				close(streamId);
			}, 30_000);
			session.timer.unref();
			const snapshot = yield* captureSnapshot(adapter, session.target, 10_000);
			session.seq += 1;
			return {
				schema_version: 1,
				stream_id: streamId,
				seq: session.seq,
				data_b64: snapshot.toString("base64"),
			};
		});
	}

	owned(
		principal: Principal,
		streamId: string | undefined,
	): Effect.Effect<TerminalSession, TerminalDomainError> {
		const authorize = this.authorize.bind(this);
		const audit = this.audit.bind(this);
		const sessions = this.sessions;
		return Effect.gen(function* () {
			yield* authorize(principal).pipe(
				Effect.catch((denial: TerminalDomainError) =>
					audit(principal, "denied", null, null, denial.message).pipe(
						Effect.ignore,
						Effect.flatMap(() => Effect.fail(denial)),
					),
				),
			);
			const id = streamId ?? "";
			const session = sessions.get(id);
			if (!session || session.closed || session.principalId !== principal.id) {
				yield* Effect.ignore(audit(principal, "denied", null, id || null, "stream not owned"));
				return yield* Effect.fail(
					new TerminalDomainError(404, "stream_not_found", "terminal stream not found", false),
				);
			}
			return session;
		});
	}

	create(
		principal: Principal,
		target: TerminalTarget,
		streamId: string,
		writable: boolean,
	): TerminalSession {
		const session: TerminalSession = {
			principalId: principal.id,
			target,
			writable,
			attached: false,
			closed: false,
			seq: 0,
			timer: null,
			end: () => {},
		};
		this.sessions.set(streamId, session);
		return session;
	}

	close(streamId: string): void {
		const session = this.sessions.get(streamId);
		if (!session) return;
		session.closed = true;
		if (session.timer) clearTimeout(session.timer);
		this.sessions.delete(streamId);
	}

	closeAll(): void {
		for (const streamId of this.sessions.keys()) this.close(streamId);
	}
}

export const readTerminalAccess = (
	services: Services,
	principal: Principal,
	adapter?: TerminalAdapter,
): Effect.Effect<TerminalAccess, TerminalDomainError> =>
	terminalService(services, adapter).access(principal);

const terminalServices = new WeakMap<Services, TerminalService>();

export function terminalService(services: Services, adapter?: TerminalAdapter): TerminalService {
	const existing = terminalServices.get(services);
	if (existing && (!adapter || existing.adapter === adapter)) return existing;
	const service = new TerminalService(services, adapter);
	terminalServices.set(services, service);
	return service;
}
