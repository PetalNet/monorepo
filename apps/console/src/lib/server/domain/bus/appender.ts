import { asynchronously } from "#domain/iteration";
// THE single serialized appender (contract §4.1, §5). All emissions funnel through one async
// queue, so seq is assigned in commit order (no assignment/commit race) and fan-out is strictly
// post-commit in seq order. Dedup is transactional: ON CONFLICT (id) returns the ORIGINAL seq with
// no fan-out. Edges are materialized from links atomically with the event.
import { required } from "#format";

import type { Sql } from "../db/pool.ts";
import type { Emission } from "../emission.ts";
import { emissionFingerprint } from "../ingest/fingerprint.ts";
import { embedText, EMBEDDING_MODEL, vectorLiteral } from "../semantic/embedding.ts";
import {
	cardinalityClass,
	deriveSemanticShape,
	dimensionValueHash,
	mergeSemanticShape,
	semanticDocument,
	type SemanticShape,
} from "../semantic/registry.ts";

export type AppendResult =
	| {
			readonly ok: true;
			readonly seq: number;
			readonly duplicate: boolean;
	  }
	| {
			readonly ok: false;
			readonly code: "emit_rate_limited" | "new_type_rate_limited" | "id_reused";
			readonly message: string;
			readonly retryAfterS?: number;
	  };

export interface AppendLimits {
	readonly maxEmitPerMinute: number;
	readonly maxNewTypesPerHour: number;
}

interface SemanticRow extends SemanticShape {
	readonly scopes: string[];
}

type ScopedSemanticRow = SemanticShape;

interface AcceptedInternal {
	readonly ok: true;
	readonly seq: number;
	readonly duplicate: boolean;
	readonly receivedAt: string;
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
	append(e: Emission, producerSubject: string, limits: AppendLimits): Promise<AppendResult> {
		const run = this.#tail.then(() => this.#doAppend(e, producerSubject, limits));
		// keep the chain alive even if this append rejects, so one failure doesn't wedge the queue
		this.#tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async #doAppend(
		e: Emission,
		producerSubject: string,
		limits: AppendLimits,
	): Promise<AppendResult> {
		const result = await this.#sql.begin(async (tx) => {
			const payloadSha256 = emissionFingerprint(e);
			// Serialize the durable decision by id across every process and statistic type. Without this
			// lock, two simultaneous retries can both miss the gate and consume rate budget before one
			// loses ON CONFLICT.
			await tx`select pg_advisory_xact_lock(hashtextextended(${e.id}, 1))`;
			// Idempotent retries never consume producer rate budget and preserve the original seq.
			const duplicate = await tx<{ seq: string; payload_sha256: string | null }[]>`
				select seq, payload_sha256 from emission_ids where id = ${e.id}`;
			for (const prior of duplicate.slice(0, 1)) {
				if (prior.payload_sha256 && prior.payload_sha256 !== payloadSha256)
					return {
						ok: false as const,
						code: "id_reused" as const,
						message: "emission id was already used with a different body",
					};
				return {
					ok: true as const,
					seq: Number(prior.seq),
					duplicate: true,
					receivedAt: "",
				};
			}
			const quarantined = await tx<
				{ reason: string; payload_sha256: string | null; retry_after: string | null }[]
			>`select reason, payload_sha256, retry_after from emission_quarantine where id = ${e.id}`;
			for (const quarantine of quarantined.slice(0, 1)) {
				if (quarantine.payload_sha256 && quarantine.payload_sha256 !== payloadSha256)
					return {
						ok: false as const,
						code: "id_reused" as const,
						message: "emission id was already used with a different body",
					};
				const retryAfter = quarantine.retry_after;
				const retryAt =
					retryAfter === null ? Number.POSITIVE_INFINITY : new Date(required(retryAfter)).getTime();
				if (retryAt > Date.now()) {
					const code = quarantine.reason as "emit_rate_limited" | "new_type_rate_limited";
					return {
						ok: false as const,
						code,
						message:
							code === "emit_rate_limited"
								? "producer emission rate exceeded"
								: "producer new-type registration rate exceeded",
						retryAfterS: Number.isFinite(retryAt)
							? Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))
							: undefined,
					};
				}
			}

			// The in-process queue preserves commit order; this database lock also serializes the
			// semantic read/merge across multiple console-api processes.
			await tx`select pg_advisory_xact_lock(hashtextextended(${e.type}, 0))`;
			const registry = await tx<SemanticRow[]>`
				select dimensions, measures, joins, scopes from semantic_registry where type = ${e.type}
				for update`;
			const scopedRegistry = await tx<ScopedSemanticRow[]>`
				select dimensions, measures, joins from semantic_registry_scoped
				where type = ${e.type} and scope = ${e.scope} for update`;
			// Registration visibility is per scope, so its cap cannot be used to probe whether the same
			// type exists in another scope.
			const isNewType = scopedRegistry.length === 0;
			const rates = await tx<{ minute_emit_count: number; hour_new_type_count: number }[]>`
				insert into producer_rate_windows
					(subject, minute_emit_count, hour_new_type_count)
				values (${producerSubject}, 1, ${isNewType ? 1 : 0})
				on conflict (subject) do update set
					minute_emit_count = case
						when producer_rate_windows.minute_started_at <= clock_timestamp() - interval '1 minute'
						then 1 else producer_rate_windows.minute_emit_count + 1 end,
					minute_started_at = case
						when producer_rate_windows.minute_started_at <= clock_timestamp() - interval '1 minute'
						then clock_timestamp() else producer_rate_windows.minute_started_at end,
					hour_new_type_count = case
						when producer_rate_windows.hour_started_at <= clock_timestamp() - interval '1 hour'
						then ${isNewType ? 1 : 0}
						else producer_rate_windows.hour_new_type_count + ${isNewType ? 1 : 0} end,
					hour_started_at = case
						when producer_rate_windows.hour_started_at <= clock_timestamp() - interval '1 hour'
						then clock_timestamp() else producer_rate_windows.hour_started_at end
				returning minute_emit_count, hour_new_type_count`;
			const rate = rates[0];
			const rejectedCode =
				rate.minute_emit_count > limits.maxEmitPerMinute
					? ("emit_rate_limited" as const)
					: rate.hour_new_type_count > limits.maxNewTypesPerHour
						? ("new_type_rate_limited" as const)
						: null;
			if (rejectedCode) {
				await tx`
					insert into emission_quarantine
						(id, producer_subject, statistic_type, scope, reason, payload_sha256, retry_after)
					values (${e.id}, ${producerSubject}, ${e.type}, ${e.scope}, ${rejectedCode}, ${payloadSha256},
						clock_timestamp() + case when ${rejectedCode} = 'emit_rate_limited'
						then interval '1 minute' else interval '1 hour' end)
					on conflict (id) do update set reason = excluded.reason,
						observed_at = clock_timestamp(), retry_after = excluded.retry_after`;
				if (rejectedCode === "new_type_rate_limited")
					await tx`
						insert into semantic_proposals
							(kind, producer_subject, statistic_type, scope, payload)
						select 'new_type_rate_cap', ${producerSubject}, ${e.type}, ${e.scope},
							${tx.json({ cap: limits.maxNewTypesPerHour })}
						where not exists (
							select 1 from semantic_proposals where status = 'pending'
							  and kind = 'new_type_rate_cap' and producer_subject = ${producerSubject}
							  and statistic_type = ${e.type}
						)`;
				return {
					ok: false as const,
					code: rejectedCode,
					message:
						rejectedCode === "emit_rate_limited"
							? "producer emission rate exceeded"
							: "producer new-type registration rate exceeded",
					retryAfterS: rejectedCode === "emit_rate_limited" ? 60 : 3600,
				};
			}

			const ids = await tx<{ seq: string; received_at: string }[]>`
				insert into emission_ids (id, payload_sha256) values (${e.id}, ${payloadSha256})
				on conflict (id) do nothing
				returning seq, received_at`;
			if (ids.length === 0) {
				const existing = await tx<{ seq: string; payload_sha256: string | null }[]>`
					select seq, payload_sha256 from emission_ids where id = ${e.id}`;
				if (existing[0].payload_sha256 && existing[0].payload_sha256 !== payloadSha256)
					return {
						ok: false as const,
						code: "id_reused" as const,
						message: "emission id was already used with a different body",
					};
				return {
					ok: true as const,
					seq: Number(existing[0].seq),
					duplicate: true,
					receivedAt: "",
				};
			}
			const seq = Number(ids[0].seq);
			const receivedAt = ids[0].received_at;
			await tx`
				insert into events
					(seq, id, type, ts, received_at, source_service, source_host, source_agent,
					 subject, subject_kind, severity, action, task_id, scope, dimensions, measures,
					 links, body_ref, meta)
				values
					(${seq}, ${e.id}, ${e.type}, ${e.ts}, ${receivedAt}, ${e.source.service}, ${e.source.host ?? null},
					 ${e.source.agent ?? null}, ${e.subject}, ${e.subject_kind ?? null}, ${e.severity},
					 ${e.action ?? null}, ${e.task_id ?? null}, ${e.scope},
					 ${tx.json(e.dimensions ?? {})}, ${tx.json(e.measures ?? {})},
					 ${tx.json(e.links ?? [])}, ${e.body_ref ?? null}, ${tx.json(e.meta ?? {})})`;
			if (isArchiveClass(e))
				await tx`insert into event_archive
					(seq, id, type, ts, received_at, source_service, source_host, source_agent, subject,
					 subject_kind, severity, action, task_id, scope, dimensions, measures, links, body_ref, meta)
					select seq, id, type, ts, received_at, source_service, source_host, source_agent,
					 subject, subject_kind, severity, action, task_id, scope, dimensions, measures, links,
					 body_ref, meta from events
					where received_at = ${receivedAt} and seq = ${seq}`;
			// materialize edges
			const links = e.links ?? [];
			if (links.length > 0) {
				const fromKind = e.subject_kind ?? "other";
				for await (const link of asynchronously(links)) {
					await tx`insert into edges (from_kind, from_id, rel, to_kind, to_id, scope, seq)
						values (${fromKind}, ${e.subject}, ${link.rel}, ${link.to.kind}, ${link.to.id}, ${e.scope}, ${seq})`;
				}
			}
			// Auto-derive the L2 semantic type. Conflicts never mutate established semantics silently:
			// the event remains durable and the disagreement becomes a scoped curation proposal.
			const incoming = deriveSemanticShape(e);
			const emptyShape: SemanticShape = { dimensions: {}, measures: {}, joins: [] };
			const registryRow = registry.at(0);
			const global = registryRow ?? emptyShape;
			const scoped = scopedRegistry.at(0) ?? emptyShape;
			const globalMerged = mergeSemanticShape(global, incoming);
			const merged = mergeSemanticShape(scoped, incoming);
			const scopes = [...new Set([...(registryRow?.scopes ?? []), e.scope])].toSorted();
			await tx`
				insert into semantic_registry
					(type, last_emit, first_producer, dimensions, measures, joins, scopes, emit_count)
				values
					(${e.type}, ${e.ts}, ${producerSubject}, ${tx.json(globalMerged.shape.dimensions)},
					 ${tx.json(globalMerged.shape.measures)}, ${tx.json(globalMerged.shape.joins)},
					 ${tx.json(scopes)}, 1)
				on conflict (type) do update set
					last_emit = excluded.last_emit,
					emit_count = semantic_registry.emit_count + 1,
					dimensions = excluded.dimensions, measures = excluded.measures,
					joins = excluded.joins, scopes = excluded.scopes, updated_at = now()`;
			await tx`
				insert into semantic_registry_scoped
					(type, scope, last_emit, dimensions, measures, joins, emit_count)
				values
					(${e.type}, ${e.scope}, ${e.ts}, ${tx.json(merged.shape.dimensions)},
					 ${tx.json(merged.shape.measures)}, ${tx.json(merged.shape.joins)}, 1)
				on conflict (type, scope) do update set
					last_emit = excluded.last_emit,
					emit_count = semantic_registry_scoped.emit_count + 1,
					dimensions = excluded.dimensions, measures = excluded.measures,
					joins = excluded.joins, updated_at = now()`;
			for await (const drift of asynchronously(merged.drift))
				await tx`
					insert into semantic_proposals
						(kind, producer_subject, statistic_type, scope, payload)
					select 'registry_drift', ${producerSubject}, ${e.type}, ${e.scope},
						${tx.json(drift)}
					where not exists (
						select 1 from semantic_proposals where status = 'pending'
						  and kind = 'registry_drift' and statistic_type = ${e.type}
						  and payload->>'field' = ${drift.field} and payload->>'kind' = ${drift.kind}
					)`;
			for await (const [field, value] of asynchronously(Object.entries(e.dimensions ?? {}))) {
				await tx`
					insert into semantic_field_values_scoped (statistic_type, scope, field, value_hash)
					select ${e.type}, ${e.scope}, ${field}, ${dimensionValueHash(value)}
					where (select count(*) from semantic_field_values_scoped
					       where statistic_type = ${e.type} and scope = ${e.scope} and field = ${field}) <= 1000
					on conflict do nothing`;
				const counts = await tx<{ count: string }[]>`
					select count(*)::bigint as count from semantic_field_values_scoped
					where statistic_type = ${e.type} and scope = ${e.scope} and field = ${field}`;
				const descriptor = merged.shape.dimensions[field];
				descriptor.cardinality = cardinalityClass(Number(counts[0].count));
			}
			await tx`update semantic_registry_scoped
				set dimensions = ${tx.json(merged.shape.dimensions)}
				where type = ${e.type} and scope = ${e.scope}`;
			const document = semanticDocument(e.type, merged.shape);
			const embedding = vectorLiteral(embedText(document));
			await tx`
				insert into semantic_documents
					(id, kind, source_ref, content, scopes, embedding, embedding_model)
				values
					(${`stat:${e.type}:${e.scope}`}, 'statistic', ${e.type}, ${document}, ${tx.json([e.scope])},
					 ${embedding}::vector, ${EMBEDDING_MODEL})
				on conflict (id) do update set content = excluded.content, scopes = excluded.scopes,
					embedding = excluded.embedding, embedding_model = excluded.embedding_model,
					updated_at = now()`;
			return { ok: true as const, seq, duplicate: false, receivedAt };
		});
		if (result.ok && !result.duplicate) {
			const accepted = result as AcceptedInternal;
			this.#fanOut(accepted.seq, e, accepted.receivedAt);
		}
		if (result.ok) return { ok: true, seq: result.seq, duplicate: result.duplicate };
		return {
			ok: false,
			code: result.code,
			message: result.message,
			...(result.retryAfterS ? { retryAfterS: result.retryAfterS } : {}),
		};
	}
}

function isArchiveClass(e: Emission): boolean {
	if (["audit.", "term.", "edge.", "security."].some((prefix) => e.type.startsWith(prefix)))
		return true;
	return e.meta?.["retention_class"] === "audit";
}
