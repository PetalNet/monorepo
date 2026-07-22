import { flattenRosterItem } from "$lib/api/derive";
import type {
	AttentionItem,
	BoxUpdateItem,
	CatalogEntry,
	CardItem,
	ConsoleHealth,
	DashboardItem,
	EdgeSessionItem,
	ExecutorItem,
	GovernanceItem,
	GovernancePool,
	HeartbeatItem,
	LeaseItem,
	Me,
	OpResult,
	ReadEnvelope,
	RegistryItem,
	RosterItem,
	StructuredQuery,
	SubscriptionItem,
	TaskItem,
	WorkerItem,
} from "$lib/api/types";
import { executeOpPlane } from "$lib/server/api/console-api";
import { listDashboards } from "$lib/server/domain/dashboard/store";
import { consumeOpRateLimit } from "$lib/server/domain/op-rate-limit";
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
import { readTerminalAccess as readTerminalAccessCore } from "$lib/server/domain/terminal/service";
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

export interface ReadPlaneResult {
	readonly attention: ReadEnvelope<AttentionItem>;
	readonly "box-updates": ReadEnvelope<BoxUpdateItem>;
	readonly cards: ReadEnvelope<CardItem>;
	readonly catalog: ReadEnvelope<CatalogEntry>;
	readonly dashboards: ReadEnvelope<DashboardItem>;
	readonly "edge-sessions": ReadEnvelope<EdgeSessionItem>;
	readonly executors: ReadEnvelope<ExecutorItem>;
	readonly governance: ReadEnvelope<GovernanceItem> & { readonly pool?: GovernancePool };
	readonly health: ConsoleHealth;
	readonly heartbeats: ReadEnvelope<HeartbeatItem>;
	readonly leases: ReadEnvelope<LeaseItem>;
	readonly me: Me;
	readonly registry: ReadEnvelope<RegistryItem>;
	readonly roster: ReadEnvelope<RosterItem>;
	readonly subscriptions: ReadEnvelope<SubscriptionItem>;
	readonly tasks: ReadEnvelope<TaskItem>;
	readonly workers: ReadEnvelope<WorkerItem>;
}

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
export const readPlaneRemote = Query("unchecked", (plane: ReadPlane) =>
	Effect.gen(function* () {
		const domain = yield* ConsoleDomain;
		const services = yield* domain.services;
		const principal = yield* currentPrincipal;
		if (plane === "me")
			return {
				schema_version: 1,
				kind: principal.kind,
				id: principal.id,
				tiers: [...principal.tiers],
				lanes: [...principal.lanes],
				scopes: [...principal.scopes],
				zookie: principal.zookie,
			} satisfies Me;
		if (plane === "health")
			return yield* Effect.tryPromise(async () => {
				const rows = await services.db.admin<{ bus_heartbeat_at: string | null }[]>`
					select max(received_at)::text as bus_heartbeat_at
					from events where type = 'console.bus.health'`;
				return {
					lake: "ok" as const,
					seq_head: services.broker.head,
					bridges: [],
					bus_heartbeat_at: rows[0]?.bus_heartbeat_at ?? null,
				};
			});
		if (plane === "roster") {
			const result = yield* Effect.promise(() =>
				readRosterCore(services.db.app, services.tracker, principal.scopes),
			);
			return { ...result, items: result.items.map((item) => flattenRosterItem(item as never)) };
		}
		if (plane === "executors")
			return yield* Effect.promise(() => readExecutorsCore(services.db.app, principal.scopes));
		if (plane === "tasks" || plane === "leases") {
			if (!services.tracker)
				return yield* Effect.die(new Error("Tracker read adapter is unavailable"));
			return plane === "tasks"
				? readTasksCore(services.tracker, principal.scopes)
				: readLeasesCore(services.tracker, principal.scopes);
		}
		if (plane === "dashboards")
			return yield* Effect.promise(() =>
				listDashboards(services.db.app, principal.scopes, services.cursorSecret, { limit: 100 }),
			);
		if (plane === "catalog")
			return yield* Effect.promise(() =>
				readEntity(services.db.app, principal.scopes, "registry", { limit: 1_000 }),
			);
		const kind = projectedKinds[plane];
		if (kind === "attention") {
			const envelope = yield* Effect.promise(() =>
				readTypedEntity(services.db.app, principal.scopes, kind, { limit: 1_000 }),
			);
			// Attention items carry an operating lane; a caller only sees items for lanes it holds.
			return {
				...envelope,
				items: envelope.items.filter(
					(item) =>
						typeof item["lane"] !== "string" ||
						principal.lanes.some((lane) => lane === item["lane"]),
				),
			};
		}

		return yield* Effect.promise(() =>
			kind === "subscription"
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
		return yield* Effect.promise(() => runStructured(services.db.app, principal.scopes, request));
	}),
);

export const readTerminalAccessRemote = Query(
	Effect.gen(function* () {
		const domain = yield* ConsoleDomain;
		const services = yield* domain.services;
		const principal = yield* currentPrincipal;
		return yield* readTerminalAccessCore(services, principal);
	}),
);

export const executeNamedOp = Command(
	"unchecked",
	(input: {
		op: string;
		args: Record<string, unknown>;
		dry_run?: boolean;
		id?: string;
		reason?: string | null;
		task_id?: number | null;
	}) =>
		Effect.gen(function* () {
			const domain = yield* ConsoleDomain;
			const services = yield* domain.services;
			const principal = yield* currentPrincipal;
			const rateLimit = consumeOpRateLimit(services, principal);
			if (!rateLimit.allowed)
				return {
					schema_version: 1,
					in_reply_to: input.id ?? "rate-limited",
					ok: false,
					error: {
						code: "rate_limited",
						message: "command request rate exceeded",
						retryable: true,
					},
				} satisfies OpResult;
			// The one authoritative command plane: catalog lookup, arg validation, authz, proposal
			// posture, audit intent/outcome, and internal adapters — identical to POST /api/v1/op.
			const { body } = yield* Effect.promise(() =>
				executeOpPlane(
					services,
					services.monitor,
					{
						schema_version: 1,
						id: input.id ?? crypto.randomUUID(),
						op: input.op,
						args: input.args,
						...(input.reason !== undefined ? { reason: input.reason } : {}),
						...(input.task_id !== undefined ? { task_id: input.task_id } : {}),
						dry_run: input.dry_run ?? false,
					},
					principal,
				),
			);
			return body as unknown as OpResult;
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
		const row = rows.at(0);
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
