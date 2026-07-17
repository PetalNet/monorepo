import { randomUUID } from "node:crypto";

import type { Sql } from "../db/pool.ts";
import type { Emission } from "../emission.ts";

type SourceMode = "development" | "normal";

type EmitInternal = (emission: Emission) => Promise<{ ok: boolean; code?: string; seq?: number }>;

export interface SignalSourceModeRow {
	readonly source_service: string;
	readonly mode: SourceMode;
	readonly note: string | null;
	readonly updated_at: string;
	readonly updated_by: string;
}

export interface SignalSourceModeChange extends SignalSourceModeRow {
	readonly previous_mode: SourceMode;
}

interface PendingSourceModeEvent extends SignalSourceModeRow {
	readonly id: string;
}

export class SignalSourceModes {
	readonly #sql: Sql;
	readonly #emit: EmitInternal;

	constructor(sql: Sql, emit: EmitInternal) {
		this.#sql = sql;
		this.#emit = emit;
	}

	async set(
		actor: string,
		sourceService: string,
		mode: SourceMode,
		note: string | null,
	): Promise<SignalSourceModeChange> {
		const now = new Date().toISOString();
		const eventId = randomUUID();
		const saved = await this.#sql.begin(async (tx) => {
			// A missing row cannot be locked with FOR UPDATE. Serialize first writes by the exact
			// source key so the captured previous mode (and therefore undo) is always truthful.
			await tx`select pg_advisory_xact_lock(hashtextextended(${sourceService}, 0))`;
			const previous = await tx<{ mode: SourceMode }[]>`
				select mode from signal_source_modes where source_service = ${sourceService} for update`;
			const rows = await tx<SignalSourceModeRow[]>`
				insert into signal_source_modes
					(source_service, scope, mode, note, updated_at, updated_by)
				values (${sourceService}, 'fleet', ${mode}, ${note}, ${now}, ${actor})
				on conflict (source_service) do update set mode = excluded.mode, note = excluded.note,
					updated_at = excluded.updated_at, updated_by = excluded.updated_by
				returning source_service, mode, note, updated_at, updated_by`;
			const row = rows[0];
			if (!row) throw new Error("signal source mode was not persisted");
			await tx`
				insert into signal_source_mode_outbox
					(id, source_service, mode, note, updated_at, updated_by)
				values (${eventId}, ${sourceService}, ${mode}, ${note}, ${now}, ${actor})`;
			return { ...row, previous_mode: previous[0].mode ?? "normal" };
		});
		if (!saved) throw new Error("signal source mode was not persisted");
		await this.#publish({ id: eventId, ...saved }).catch(() => false);
		return saved;
	}

	async #publish(pending: PendingSourceModeEvent): Promise<boolean> {
		const outcome = await this.#emit({
			schema_version: 1,
			id: pending.id,
			type: "signal.source_mode_changed",
			ts: new Date(pending.updated_at).toISOString(),
			source: { service: "console-api", host: null, agent: null },
			subject: pending.source_service,
			subject_kind: "service",
			severity: "info",
			scope: "fleet",
			dimensions: {
				source_service: pending.source_service,
				mode: pending.mode,
				alerts_muted: pending.mode === "development",
				updated_by: pending.updated_by,
				...(pending.note ? { note: pending.note } : {}),
			},
			meta: { retention_class: "audit" },
		});
		if (!outcome.ok) return false;
		await this.#sql`delete from signal_source_mode_outbox where id = ${pending.id}`;
		return true;
	}

	/** Retry committed state changes whose live/audit emission could not be appended initially. */
	async reconcilePending(): Promise<number> {
		const pending = await this.#sql<PendingSourceModeEvent[]>`
			select id::text as id, source_service, mode, note, updated_at, updated_by
			from signal_source_mode_outbox order by updated_at asc limit 100`;
		const results = await Promise.allSettled(pending.map((row) => this.#publish(row)));
		return results.filter((result) => result.status === "fulfilled" && result.value).length;
	}
}
