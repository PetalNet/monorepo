// The current-state projector (N1b, PHASE1B-DESIGN §2). A CURSORED consumer, not fire-and-forget:
// on boot it replays the lake from its durable checkpoint to head (seq-guarded → idempotent), then
// goes live off the appender's fan-out. Keyed by the projection-map BUCKET (kind), NOT the
// emission subject_kind (which is `agent` for four different kinds). Scope is invariant per
// (kind, subject) by construction — the upsert never rewrites it — so visibility can never flip.

import type { Sql } from "../db/pool.ts";
import type { Emission } from "../emission.ts";

export type ProjectionKind =
	| "fleet"
	| "heartbeat"
	| "registry"
	| "governance"
	| "card"
	| "worker"
	| "box_update"
	| "edge"
	| "edge_session"
	| "attention"
	| "subscription";

const CONTRACTED_READ_KINDS = new Set<ProjectionKind>([
	"edge",
	"edge_session",
	"attention",
	"subscription",
	"box_update",
]);

/** Map an emission type to its projection bucket, or null if the type is not state-bearing. */
function projectionKind(type: string): ProjectionKind | null {
	if (type.startsWith("fleet.event")) return "fleet";
	if (type === "agent.heartbeat" || type === "agent.crashed" || type.startsWith("channel."))
		return "heartbeat";
	if (type === "agent.capacity") return "registry";
	if (type === "governance.action" || type === "usage.report") return "governance";
	if (type.startsWith("card.")) return "card";
	if (type.startsWith("worker.")) return "worker";
	if (type === "box.update_status_changed") return "box_update";
	if (type.startsWith("attention.")) return "attention";
	if (type.startsWith("subscription.")) return "subscription";
	if (type.startsWith("doorman.enroll.") || type.startsWith("edge.key_")) return "edge";
	if (
		type.startsWith("doorman.session.") ||
		type.startsWith("doorman.link.") ||
		type === "doorman.degrade" ||
		type === "doorman.recover"
	)
		return "edge_session";
	return null;
}

function typedEntityOf(e: Emission): Record<string, unknown> {
	const entity = e.meta?.["entity"];
	return entity && typeof entity === "object" && !Array.isArray(entity)
		? (entity as Record<string, unknown>)
		: {};
}

function projectionSubject(e: Emission, kind: ProjectionKind): string {
	const typedEntity = typedEntityOf(e);
	if (kind === "edge_session") {
		const sessionId = typedEntity["session_id"] ?? e.dimensions?.["session_id"];
		if (typeof sessionId === "string" && sessionId) return sessionId;
	}
	return e.subject;
}

/** The state payload persisted for an entity — salient emission fields the typed reads shape from. */
function stateOf(e: Emission): Record<string, unknown> {
	const typedEntity = typedEntityOf(e);
	const raw = e.meta?.["box_update_raw"];
	return {
		schema_version: 1,
		subject: e.subject,
		scope: e.scope,
		ts: e.ts,
		source: e.source.service,
		host: e.source.host,
		agent: e.source.agent,
		severity: e.severity,
		action: e.action ?? null,
		task_id: e.task_id ?? null,
		...e.dimensions,
		...e.measures,
		...typedEntity,
		...(raw && typeof raw === "object" && !Array.isArray(raw) ? { box_update_raw: raw } : {}),
	};
}

export interface ProjectorAlarm {
	(type: string, subject: string, message: string): void;
}

// Aggregate-surface kinds MUST carry the `fleet` scope so a fleet-granted viewer can read them
// (flat model: `fleet` does not imply `agent:x`). A per-agent-private projection is Phase 3+.
const AGGREGATE_KINDS = new Set<ProjectionKind>([
	"fleet",
	"heartbeat",
	"registry",
	"governance",
	"card",
	"box_update",
	"edge",
	"edge_session",
]);

const MERGED_STATE_KINDS = new Set<ProjectionKind>(["edge_session", "attention", "subscription"]);
// A stable 64-bit key for the projector's pg advisory lock (guards concurrent replay).
const REPLAY_LOCK_KEY = 738120;
const CONTRACTED_REPLAY_LOCK_KEY = 738121;
const CONTRACTED_REPLAY_NAME = "current_state_br008";

export class Projector {
	readonly #writer: Sql;
	readonly #alarm: ProjectorAlarm;
	readonly name = "current_state";
	// Serialize live applies (codex N1b-1 P0): fan-out arrives in seq order; applying one-at-a-time
	// keeps the checkpoint contiguous so a crash never skips an unfinished seq.
	#tail: Promise<unknown> = Promise.resolve();
	// Bound the in-flight queue (codex N1b-1 P2): under a DB stall the chain would grow unboundedly.
	// Dropping a live apply is SAFE — the checkpoint only advances contiguously, so it stops at the
	// gap and a later replay refills it (events are durable in the lake); we alarm so the lag shows.
	#pending = 0;
	#backpressured = false;
	static readonly #MAX_PENDING = 5000;

	constructor(writer: Sql, alarm?: ProjectorAlarm) {
		this.#writer = writer;
		this.#alarm = alarm ?? (() => {});
	}

	/**
	 * Boot replay: apply every lake event past the checkpoint, in seq order, up to head. Idempotent.
	 * Takes a transaction-scoped advisory lock so two instances cannot replay concurrently.
	 */
	async replayToHead(): Promise<void> {
		// One transaction for the whole boot replay. pg_advisory_XACT_lock is bound to THIS
		// transaction's backend and auto-releases at commit — safe over a pooled connection, unlike a
		// session-level lock whose unlock could land on a different pooled backend (codex re-review).
		await this.#writer.begin(async (tx) => {
			await tx`select pg_advisory_xact_lock(${REPLAY_LOCK_KEY})`;
			await this.#replayLocked(tx as Sql, this.name, false);
		});
	}

	/** One-time/continuing replay for BR-008 kinds, independent of the established main checkpoint. */
	async replayContractedReadsToHead(): Promise<void> {
		await this.#writer.begin(async (tx) => {
			await tx`select pg_advisory_xact_lock(${CONTRACTED_REPLAY_LOCK_KEY})`;
			await this.#replayLocked(tx as Sql, CONTRACTED_REPLAY_NAME, true);
		});
	}

	async #replayLocked(tx: Sql, checkpointName: string, contractedOnly: boolean): Promise<void> {
		const ck = await tx<{ through_seq: string }[]>`
			insert into projection_checkpoint (name, through_seq) values (${checkpointName}, 0)
			on conflict (name) do update set name = excluded.name
			returning through_seq`;
		let cursor = Number(ck[0]?.through_seq ?? 0);
		const replayHead = contractedOnly
			? Number(
					(await tx<{ seq: string }[]>`select coalesce(max(seq), 0)::bigint as seq from events`)[0]
						?.seq ?? 0,
				)
			: null;
		for (;;) {
			const rows = await tx<
				{
					seq: string;
					type: string;
					subject: string;
					subject_kind: string | null;
					scope: string;
					received_at: string;
					ts: string;
					source_service: string;
					source_host: string | null;
					source_agent: string | null;
					severity: string;
					action: string | null;
					task_id: string | null;
					dimensions: Record<string, unknown>;
					measures: Record<string, unknown>;
					meta: NonNullable<Emission["meta"]>;
				}[]
			>`
				select seq, type, subject, subject_kind, scope, received_at, ts, source_service, source_host,
					source_agent, severity, action, task_id, dimensions, measures, meta
				from events
				where seq > ${cursor} and (${replayHead}::bigint is null or seq <= ${replayHead})
				  and (not ${contractedOnly} or type like 'attention.%' or type like 'subscription.%'
				    or type in ('box.update_status_changed', 'doorman.degrade', 'doorman.recover')
				    or type like 'doorman.enroll.%' or type like 'doorman.session.%'
				    or type like 'doorman.link.%' or type like 'edge.key_%')
				order by seq asc limit 5000`;
			if (rows.length === 0) {
				if (contractedOnly)
					await tx`update projection_checkpoint set
						through_seq = ${replayHead}, updated_at = now()
						where name = ${checkpointName}`;
				break;
			}
			for (const r of rows) {
				const e: Emission = {
					schema_version: 1,
					id: "",
					type: r.type,
					ts: typeof r.ts === "string" ? r.ts : new Date(r.ts).toISOString(),
					source: { service: r.source_service, host: r.source_host, agent: r.source_agent },
					subject: r.subject,
					subject_kind: r.subject_kind as Emission["subject_kind"],
					severity: r.severity as Emission["severity"],
					action: r.action,
					task_id: r.task_id === null ? null : Number(r.task_id),
					scope: r.scope,
					dimensions: r.dimensions as Emission["dimensions"],
					measures: r.measures as Emission["measures"],
					meta: r.meta,
				};
				const kind = projectionKind(e.type);
				if (!contractedOnly || (kind && CONTRACTED_READ_KINDS.has(kind)))
					await this.#apply(
						tx,
						Number(r.seq),
						e,
						typeof r.received_at === "string"
							? r.received_at
							: new Date(r.received_at).toISOString(),
					);
				cursor = Number(r.seq);
				// monotonic checkpoint (codex P1): only ever advance, never regress.
				await tx`update projection_checkpoint set through_seq = ${cursor}, updated_at = now()
					where name = ${checkpointName} and through_seq < ${cursor}`;
			}
			if (rows.length < 5000) {
				if (contractedOnly)
					await tx`update projection_checkpoint set
						through_seq = ${replayHead}, updated_at = now()
						where name = ${checkpointName}`;
				break;
			}
		}
	}

	/**
	 * Live path: called by the appender's fan-out, post-commit, in seq order. Serialized so the
	 * checkpoint advances CONTIGUOUSLY — a crash never skips an unfinished seq (codex P0).
	 */
	onEvent(seq: number, e: Emission, receivedAt: string): void {
		if (this.#pending >= Projector.#MAX_PENDING) {
			if (!this.#backpressured) {
				this.#backpressured = true;
				this.#alarm(
					"projection.backpressure",
					e.subject,
					`dropping live apply at seq ${String(seq)}; replay will refill`,
				);
			}
			return; // safe: checkpoint stalls at the gap, a later replay refills it
		}
		this.#backpressured = false;
		this.#pending += 1;
		const run = this.#tail.then(async () => {
			await this.#apply(this.#writer, seq, e, receivedAt);
			// advance ONLY if the previous seq is already checkpointed (contiguous); a no-op otherwise.
			await this.#writer`update projection_checkpoint set through_seq = ${seq}, updated_at = now()
				where name = ${this.name} and through_seq = ${seq - 1}`;
		});
		this.#tail = run
			.catch((err: unknown) => {
				this.#alarm("projection.apply_failed", e.subject, String(err));
			})
			.finally(() => {
				this.#pending -= 1;
			});
	}

	async #apply(sql: Sql, seq: number, e: Emission, receivedAt: string): Promise<void> {
		// bridge.source.unreachable marks the affected entities dark (positive down-evidence, L2).
		// seq-guarded (codex P1): only mark a row dark if its last state is not newer than this signal,
		// so a delayed old unreachable cannot re-mark a freshly-healthy entity.
		if (e.type === "bridge.source.unreachable") {
			await sql`update current_state set unreachable_since = ${receivedAt}
				where subject = ${e.subject} and unreachable_since is null and seq <= ${seq}`;
			return;
		}
		const kind = projectionKind(e.type);
		if (!kind) return;
		const subject = projectionSubject(e, kind);
		// Aggregate-surface kinds must be `fleet`-scoped (codex P1): reject a non-fleet scope so a
		// wrongly-stamped emission can never make aggregate state invisible to fleet viewers.
		if (AGGREGATE_KINDS.has(kind) && e.scope !== "fleet") {
			this.#alarm(
				"projection.bad_aggregate_scope",
				e.subject,
				`${kind} requires fleet scope, got ${e.scope}`,
			);
			return;
		}
		if (
			kind === "subscription" &&
			(e.type === "subscription.removed" ||
				e.action === "remove" ||
				e.dimensions?.["removed"] === true)
		) {
			await sql`delete from current_state
				where kind = 'subscription' and subject = ${subject} and scope = ${e.scope} and seq < ${seq}`;
			return;
		}
		// Scope invariance (codex P1): the update predicate requires the SAME scope, so a differing
		// scope never applies new state under the old scope (which would flip visibility). A mismatch
		// is a no-op here and is alarmed separately below.
		const rows = await sql<{ scope: string }[]>`
			insert into current_state (kind, subject, scope, state, observed_at, producer_ts, seq, unreachable_since)
			values (${kind}, ${subject}, ${e.scope}, ${sql.json(stateOf(e) as never)}, ${receivedAt}, ${e.ts}, ${seq}, null)
			on conflict (kind, subject) do update
				set state = case when ${MERGED_STATE_KINDS.has(kind)}
					then current_state.state || excluded.state else excluded.state end,
					observed_at = excluded.observed_at, producer_ts = excluded.producer_ts,
					seq = excluded.seq, unreachable_since = null
				where excluded.seq > current_state.seq and current_state.scope = excluded.scope
			returning scope`;
		if (rows.length === 0) {
			// either a stale seq (no-op) or a scope mismatch — check for the latter to alarm.
			const cur = await sql<
				{ scope: string; seq: string }[]
			>`select scope, seq from current_state where kind = ${kind} and subject = ${subject}`;
			const c = cur[0];
			if (c && c.scope !== e.scope && Number(c.seq) < seq) {
				this.#alarm(
					"projection.scope_conflict",
					subject,
					`${kind} scope ${e.scope} != invariant ${c.scope} (not applied)`,
				);
			}
			return;
		}
		const storedScope = rows[0]?.scope;
		if (storedScope !== undefined && storedScope !== e.scope) {
			this.#alarm(
				"projection.scope_conflict",
				e.subject,
				`${kind} scope ${e.scope} != invariant ${storedScope}`,
			);
		}
	}
}
