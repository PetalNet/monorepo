// The co-located bridge (N1b-3, PHASE1B-DESIGN §3). Tails .14-local as-built sources on a poll and
// emits them into the lake via the normal emit path (authz + scrubber + dedup all apply). Remote
// boxes run their own per-box bridge (the future Rust `console-bridge`); this one covers the
// .14-local sources. Deterministic ids make every poll idempotent; a durable cursor per source
// resumes after restart; an unreadable source emits `bridge.source.unreachable` (a dark source is a
// signal, not an absence).

import type { Sql } from "../db/pool.ts";
import type { Emission } from "../emission.ts";
import { tailSystemOutbox } from "./system-outbox.ts";
import { uuidv5 } from "./uuid5.ts";

export interface EmitFn {
	(
		producerSubject: string,
		emission: Emission,
		bytes: number,
	): Promise<{ ok: boolean; code?: string }>;
}

const PRODUCER = "bridge:system-outbox";

export interface BridgeConfig {
	readonly systemOutboxDir?: string | undefined;
}

interface Cursor {
	readonly cursor: string;
	readonly belowCount: number;
}

export class Bridge {
	readonly #writer: Sql;
	readonly #emit: EmitFn;
	readonly #config: BridgeConfig;
	#timer: ReturnType<typeof setInterval> | null = null;
	#polling = false;
	// Per-source liveness, for emit-on-transition (never per-poll spam during an outage).
	readonly #dark = new Set<string>();

	constructor(writer: Sql, emit: EmitFn, config: BridgeConfig) {
		this.#writer = writer;
		this.#emit = emit;
		this.#config = config;
	}

	async #cursor(source: string): Promise<Cursor> {
		const sql = this.#writer;
		const rows = await sql<
			{ cursor: string; below_count: number }[]
		>`select cursor, below_count from bridge_cursor where source = ${source}`;
		const row = rows[0];
		return { cursor: row?.cursor ?? "", belowCount: Number(row?.below_count ?? 0) };
	}

	async #setCursor(source: string, c: Cursor): Promise<void> {
		const sql = this.#writer;
		await sql`insert into bridge_cursor (source, cursor, below_count) values (${source}, ${c.cursor}, ${c.belowCount})
			on conflict (source) do update set cursor = excluded.cursor, below_count = excluded.below_count, updated_at = now()`;
	}

	async #emitOne(e: Emission): Promise<void> {
		const r = await this.#emit(PRODUCER, e, Buffer.byteLength(JSON.stringify(e)));
		// A rejected emit must NOT be swallowed: throwing here leaves the cursor un-advanced so the
		// next poll re-tails and re-emits (the deterministic id dedups the ones that did land). The
		// tailer only ever produces allowed shapes (bot.message / fleet / <=danger), so ok:false means
		// the producer registration is wrong — a deploy fault we want to surface loudly (a stalled
		// cursor), not a silent whole-feed drop.
		if (!r.ok) throw new Error(`bridge emit rejected: ${r.code ?? "unknown"} (${e.type})`);
	}

	#control(source: string, type: string, ts: string, severity: Emission["severity"]): Emission {
		return {
			schema_version: 1,
			id: uuidv5(`${type}:${source}:${ts}`),
			type,
			ts,
			source: { service: "bridge", host: ".14", agent: null },
			subject: source,
			severity,
			scope: "fleet",
		};
	}

	/**
	 * One poll pass over all configured sources. `now` is the RFC 3339 ingest time. Single-flight: a
	 * tick that lands while a prior poll is still running is dropped, so cursors never race.
	 */
	async pollOnce(now: string): Promise<void> {
		if (this.#polling) return;
		this.#polling = true;
		try {
			if (this.#config.systemOutboxDir)
				await this.#pollSystemOutbox(this.#config.systemOutboxDir, now);
		} finally {
			this.#polling = false;
		}
	}

	async #pollSystemOutbox(dir: string, now: string): Promise<void> {
		const source = "system-outbox";
		const prev = await this.#cursor(source);
		let result;
		try {
			result = tailSystemOutbox(dir, prev.cursor, prev.belowCount, now);
		} catch {
			// The source is dark — emit a positive down-signal ONCE on the healthy->dark transition,
			// not every poll (a 5s poll would otherwise mint ~17k duplicate warnings a day).
			if (!this.#dark.has(source)) {
				this.#dark.add(source);
				await this.#emitOne(this.#control(source, "bridge.source.unreachable", now, "warn"));
			}
			return;
		}
		if (this.#dark.delete(source))
			await this.#emitOne(this.#control(source, "bridge.source.recovered", now, "info"));
		if (result.anomaly)
			await this.#emitOne(this.#control(source, "bridge.source.anomaly", now, "warn"));
		for (const e of result.emissions) await this.#emitOne(e);
		if (result.cursor !== prev.cursor || result.belowCount !== prev.belowCount)
			await this.#setCursor(source, { cursor: result.cursor, belowCount: result.belowCount });
	}

	start(intervalMs: number): void {
		if (this.#timer) return;
		this.#timer = setInterval(() => {
			void this.pollOnce(new Date().toISOString()).catch((err: unknown) => {
				// Don't die on a transient DB/emit error; surface it so an operator isn't left blind.
				process.stderr.write(`bridge poll failed: ${String(err)}\n`);
			});
		}, intervalMs);
		this.#timer.unref();
	}

	stop(): void {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = null;
	}
}
