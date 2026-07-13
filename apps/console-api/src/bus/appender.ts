// THE single serialized appender (contract §4.1, §5). All emissions funnel through one async
// queue, so seq is assigned in commit order (no assignment/commit race) and fan-out is strictly
// post-commit in seq order. Dedup is transactional: ON CONFLICT (id) returns the ORIGINAL seq with
// no fan-out. Edges are materialized from links atomically with the event.

import type { Sql } from "../db/pool.ts";
import type { Emission } from "../emission.ts";

export interface AppendResult {
	readonly seq: number;
	readonly duplicate: boolean;
}

// receivedAt = the lake receipt time (immutable), threaded to the projector for skew-proof
// freshness (N1b). The broker ignores it; the projector uses it as current_state.observed_at.
export type FanOut = (seq: number, e: Emission, receivedAt: string) => void;

export class Appender {
	readonly #sql: Sql;
	readonly #fanOut: FanOut;
	#tail: Promise<unknown> = Promise.resolve();

	constructor(sql: Sql, fanOut: FanOut) {
		this.#sql = sql;
		this.#fanOut = fanOut;
	}

	/** Serialized: each append waits for the previous to fully commit before assigning the next seq. */
	append(e: Emission): Promise<AppendResult> {
		const run = this.#tail.then(() => this.#doAppend(e));
		// keep the chain alive even if this append rejects, so one failure doesn't wedge the queue
		this.#tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async #doAppend(e: Emission): Promise<AppendResult> {
		const result = await this.#sql.begin(async (tx) => {
			const rows = await tx<{ seq: string; received_at: string }[]>`
				insert into events
					(id, type, ts, source_service, source_host, source_agent, subject, subject_kind,
					 severity, action, task_id, scope, dimensions, measures, links, body_ref, meta)
				values
					(${e.id}, ${e.type}, ${e.ts}, ${e.source.service}, ${e.source.host ?? null},
					 ${e.source.agent ?? null}, ${e.subject}, ${e.subject_kind ?? null}, ${e.severity},
					 ${e.action ?? null}, ${e.task_id ?? null}, ${e.scope},
					 ${tx.json((e.dimensions ?? {}) as never)}, ${tx.json((e.measures ?? {}) as never)},
					 ${tx.json((e.links ?? []) as never)}, ${e.body_ref ?? null}, ${tx.json((e.meta ?? {}) as never)})
				on conflict (id) do nothing
				returning seq, received_at`;
			if (rows.length === 0) {
				const existing = await tx<{ seq: string }[]>`select seq from events where id = ${e.id}`;
				return { seq: Number(existing[0]?.seq), duplicate: true, receivedAt: "" };
			}
			const seq = Number(rows[0]?.seq);
			const receivedAt = rows[0]?.received_at ?? new Date().toISOString();
			// materialize edges
			if (e.links && e.links.length > 0) {
				const fromKind = e.subject_kind ?? "other";
				for (const link of e.links) {
					await tx`insert into edges (from_kind, from_id, rel, to_kind, to_id, scope, seq)
						values (${fromKind}, ${e.subject}, ${link.rel}, ${link.to.kind}, ${link.to.id}, ${e.scope}, ${seq})`;
				}
			}
			// auto-register / update the semantic type (L2 input)
			await tx`
				insert into semantic_registry (type, last_emit, dimensions, measures, scopes, emit_count)
				values (${e.type}, ${e.ts}, ${tx.json(dimShape(e))}, ${tx.json(measShape(e))}, ${tx.json([e.scope])}, 1)
				on conflict (type) do update set
					last_emit = excluded.last_emit,
					emit_count = semantic_registry.emit_count + 1,
					dimensions = semantic_registry.dimensions || excluded.dimensions,
					measures = semantic_registry.measures || excluded.measures,
					scopes = case when semantic_registry.scopes @> excluded.scopes
						then semantic_registry.scopes else semantic_registry.scopes || excluded.scopes end`;
			return { seq, duplicate: false, receivedAt };
		});
		if (!result.duplicate) this.#fanOut(result.seq, e, result.receivedAt);
		return { seq: result.seq, duplicate: result.duplicate };
	}
}

function dimShape(e: Emission): Record<string, string> {
	const out: Record<string, string> = {};
	for (const k of Object.keys(e.dimensions ?? {}))
		out[k] =
			typeof (e.dimensions as Record<string, unknown>)[k] === "boolean" ? "boolean" : "string";
	return out;
}
function measShape(e: Emission): Record<string, string> {
	const out: Record<string, string> = {};
	for (const k of Object.keys(e.measures ?? {})) out[k] = e.meta?.fields?.[k]?.kind ?? "gauge";
	return out;
}
