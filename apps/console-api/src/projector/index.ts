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
	| "edge";

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
	if (type.startsWith("doorman.")) return "edge";
	return null;
}

/** The state payload persisted for an entity — salient emission fields the typed reads shape from. */
function stateOf(e: Emission): Record<string, unknown> {
	return {
		subject: e.subject,
		host: e.source.host,
		agent: e.source.agent,
		severity: e.severity,
		action: e.action ?? null,
		task_id: e.task_id ?? null,
		...e.dimensions,
		...e.measures,
	};
}

export interface ProjectorAlarm {
	(type: string, subject: string, message: string): void;
}

export class Projector {
	readonly #writer: Sql;
	readonly #alarm: ProjectorAlarm;
	readonly name = "current_state";

	constructor(writer: Sql, alarm?: ProjectorAlarm) {
		this.#writer = writer;
		this.#alarm = alarm ?? (() => {});
	}

	/** Boot replay: apply every lake event past the checkpoint, in seq order, up to head. Idempotent. */
	async replayToHead(): Promise<void> {
		const ck = await this.#writer<{ through_seq: string }[]>`
			insert into projection_checkpoint (name, through_seq) values (${this.name}, 0)
			on conflict (name) do update set name = excluded.name
			returning through_seq`;
		let cursor = Number(ck[0]?.through_seq ?? 0);
		for (;;) {
			const rows = await this.#writer<
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
				}[]
			>`
				select seq, type, subject, subject_kind, scope, received_at, ts, source_service, source_host,
					source_agent, severity, action, task_id, dimensions, measures
				from events where seq > ${cursor} order by seq asc limit 5000`;
			if (rows.length === 0) break;
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
				};
				await this.#apply(
					Number(r.seq),
					e,
					typeof r.received_at === "string" ? r.received_at : new Date(r.received_at).toISOString(),
				);
				cursor = Number(r.seq);
			}
			await this.#writer`update projection_checkpoint set through_seq = ${cursor}, updated_at = now() where name = ${this.name}`;
			if (rows.length < 5000) break;
		}
	}

	/** Live path: called by the appender's fan-out, post-commit, in seq order. */
	onEvent(seq: number, e: Emission, receivedAt: string): void {
		void this.#apply(seq, e, receivedAt)
			.then(
				() =>
					this.#writer`update projection_checkpoint set through_seq = ${seq}, updated_at = now() where name = ${this.name} and through_seq < ${seq}`,
			)
			.catch((err: unknown) => {
				this.#alarm("projection.apply_failed", e.subject, String(err));
			});
	}

	async #apply(seq: number, e: Emission, receivedAt: string): Promise<void> {
		// bridge.source.unreachable marks the affected entities dark (positive down-evidence, L2).
		if (e.type === "bridge.source.unreachable") {
			await this.#writer`update current_state set unreachable_since = ${receivedAt}
				where subject = ${e.subject} and unreachable_since is null`;
			return;
		}
		const kind = projectionKind(e.type);
		if (!kind) return;
		// scope invariance: the upsert NEVER rewrites scope, so visibility cannot flip. A differing
		// scope on a live update is a producer bug — alarm, don't apply the new scope.
		const rows = await this.#writer<{ scope: string }[]>`
			insert into current_state (kind, subject, scope, state, observed_at, producer_ts, seq, unreachable_since)
			values (${kind}, ${e.subject}, ${e.scope}, ${this.#writer.json(stateOf(e) as never)}, ${receivedAt}, ${e.ts}, ${seq}, null)
			on conflict (kind, subject) do update
				set state = excluded.state, observed_at = excluded.observed_at, producer_ts = excluded.producer_ts,
					seq = excluded.seq, unreachable_since = null
				where excluded.seq > current_state.seq
			returning scope`;
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
