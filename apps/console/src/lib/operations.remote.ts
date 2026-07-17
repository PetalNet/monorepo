import { flattenRosterItem } from "$lib/api/derive";
import type { Me, OpResult, StructuredQuery } from "$lib/api/types";
import { listDashboards } from "$lib/server/domain/dashboard/store";
import { currentPrincipal } from "$lib/server/domain/principal";
import { runStructured } from "$lib/server/domain/query/structured";
import { readEntity, readTypedEntity } from "$lib/server/domain/reads/entities";
import {
	readExecutors as readExecutorsCore,
	readRoster as readRosterCore,
} from "$lib/server/domain/reads/roster";
import {
	readLeases as readLeasesCore,
	readTasks as readTasksCore,
} from "$lib/server/domain/reads/tracker-reads";
import { ConsoleDomain } from "$lib/server/domain/service";
import { Effect } from "effect";
import { Command, Query } from "svelte-effect-runtime";

export type ReadPlane =
	| "attention"
	| "box-updates"
	| "cards"
	| "catalog"
	| "dashboards"
	| "edge-sessions"
	| "executors"
	| "governance"
	| "health"
	| "heartbeats"
	| "leases"
	| "me"
	| "registry"
	| "roster"
	| "subscriptions"
	| "tasks"
	| "workers";

const projectedKinds = {
	attention: "attention",
	"box-updates": "box_update",
	cards: "card",
	"edge-sessions": "edge_session",
	governance: "governance",
	heartbeats: "heartbeat",
	registry: "registry",
	subscriptions: "subscription",
	workers: "worker",
} as const;

/** Canonical read plane shared by surface-specific remote delegates and REST handlers. */
export const readPlane = Query("unchecked", (plane: ReadPlane) =>
	Effect.gen(function* () {
		const domain = yield* ConsoleDomain;
		const services = yield* domain.services;
		const principal = yield* currentPrincipal;
		if (plane === "me")
			return {
				schema_version: 1,
				kind: principal.kind,
				id: principal.id,
				tiers: principal.tiers,
				lanes: principal.lanes,
				scopes: principal.scopes,
				zookie: principal.zookie,
			} satisfies Me;
		if (plane === "health")
			return {
				schema_version: 1,
				service: "console",
				status: "ready",
				seq_head: services.broker.head,
				bus_heartbeat_at: new Date().toISOString(),
			};
		if (plane === "roster") {
			const result = yield* Effect.tryPromise(() =>
				readRosterCore(services.db.app, services.tracker, principal.scopes),
			);
			return { ...result, items: result.items.map((item) => flattenRosterItem(item as never)) };
		}
		if (plane === "executors")
			return yield* Effect.tryPromise(() => readExecutorsCore(services.db.app, principal.scopes));
		if (plane === "tasks" || plane === "leases") {
			if (!services.tracker)
				return yield* Effect.die(new Error("Tracker read adapter is unavailable"));
			return plane === "tasks"
				? readTasksCore(services.tracker, principal.scopes)
				: readLeasesCore(services.tracker, principal.scopes);
		}
		if (plane === "dashboards")
			return yield* Effect.tryPromise(() =>
				listDashboards(services.db.app, principal.scopes, services.cursorSecret, { limit: 100 }),
			);
		if (plane === "catalog")
			return yield* Effect.tryPromise(() =>
				readEntity(services.db.app, principal.scopes, "registry", { limit: 1_000 }),
			);
		const kind = projectedKinds[plane];
		if (!kind) return yield* Effect.die(new Error(`Unsupported read plane: ${plane}`));
		return yield* Effect.tryPromise(() =>
			kind === "attention" || kind === "subscription"
				? readTypedEntity(services.db.app, principal.scopes, kind, { limit: 1_000 })
				: readEntity(services.db.app, principal.scopes, kind, { limit: 1_000 }),
		);
	}),
);

export const runStructuredQuery = Query("unchecked", (request: StructuredQuery) =>
	Effect.gen(function* () {
		const domain = yield* ConsoleDomain;
		const services = yield* domain.services;
		const principal = yield* currentPrincipal;
		return yield* Effect.tryPromise(() =>
			runStructured(services.db.app, principal.scopes, request),
		);
	}),
);

export const executeNamedOp = Command(
	"unchecked",
	(input: { op: string; args: Record<string, unknown>; dry_run?: boolean }) =>
		Effect.gen(function* () {
			const domain = yield* ConsoleDomain;
			const services = yield* domain.services;
			yield* currentPrincipal;
			if (input.dry_run)
				return {
					schema_version: 1,
					in_reply_to: crypto.randomUUID(),
					ok: true,
					status: "applied",
					result: { dry_run: true, op: input.op },
				} satisfies OpResult;
			if (input.op === "task.claim" && services.trackerCommands) {
				const trackerCommands = services.trackerCommands;
				const taskId = Number(input.args["task_id"] ?? input.args["id"]);
				const result = yield* Effect.tryPromise(() => trackerCommands.claim({ taskId }));
				return {
					schema_version: 1,
					in_reply_to: crypto.randomUUID(),
					ok: true,
					status: "applied",
					result: { ...result },
				} satisfies OpResult;
			}
			return yield* Effect.die(new Error(`No authoritative adapter is configured for ${input.op}`));
		}),
);

export const getAssistantSessionRemote = Query(
	Effect.gen(function* () {
		const domain = yield* ConsoleDomain;
		const services = yield* domain.services;
		const principal = yield* currentPrincipal;
		const rows = yield* Effect.tryPromise(
			() =>
				services.db.writer<
					Array<{
						manager_session_id: string | null;
						state: string;
						window_layout: unknown;
						last_context: Record<string, unknown> | null;
					}>
				>`select manager_session_id, state, window_layout, last_context
			  from assistant_sessions where principal_id = ${principal.id}`,
		);
		const row = rows[0];
		return {
			schema_version: 1 as const,
			session: row
				? {
						session_id: row.manager_session_id,
						state: row.state,
						window_layout: row.window_layout,
						last_context: row.last_context,
					}
				: null,
		};
	}),
);

export const sendAssistantRemote = Command(
	"unchecked",
	(input: { kind: "user" | "context"; content: string }) =>
		Effect.gen(function* () {
			const domain = yield* ConsoleDomain;
			const services = yield* domain.services;
			const principal = yield* currentPrincipal;
			if (!services.assistantRuntime)
				return yield* Effect.die(new Error("Assistant manager adapter is unavailable"));
			const assistantRuntime = services.assistantRuntime;
			return yield* Effect.tryPromise(() =>
				assistantRuntime.send(principal, {
					id: crypto.randomUUID(),
					kind: input.kind,
					content: input.content,
				}),
			);
		}),
);
