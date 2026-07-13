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

export class Bridge {
	readonly #writer: Sql;
	readonly #emit: EmitFn;
	readonly #config: BridgeConfig;
	#timer: ReturnType<typeof setInterval> | null = null;

	constructor(writer: Sql, emit: EmitFn, config: BridgeConfig) {
		this.#writer = writer;
		this.#emit = emit;
		this.#config = config;
	}

	async #cursor(source: string): Promise<string> {
		const sql = this.#writer;
		const rows = await sql<
			{ cursor: string }[]
		>`select cursor from bridge_cursor where source = ${source}`;
		return rows[0]?.cursor ?? "";
	}

	async #setCursor(source: string, cursor: string): Promise<void> {
		const sql = this.#writer;
		await sql`insert into bridge_cursor (source, cursor) values (${source}, ${cursor})
			on conflict (source) do update set cursor = excluded.cursor, updated_at = now()`;
	}

	async #emitOne(e: Emission): Promise<void> {
		await this.#emit(PRODUCER, e, Buffer.byteLength(JSON.stringify(e)));
	}

	/** One poll pass over all configured sources. `now` is the RFC 3339 ingest time. */
	async pollOnce(now: string): Promise<void> {
		if (this.#config.systemOutboxDir)
			await this.#pollSystemOutbox(this.#config.systemOutboxDir, now);
	}

	async #pollSystemOutbox(dir: string, now: string): Promise<void> {
		const source = "system-outbox";
		let result: { emissions: Emission[]; cursor: string };
		try {
			result = tailSystemOutbox(dir, await this.#cursor(source), now);
		} catch {
			// the source is dark — emit a positive down-signal, do not silently show nothing.
			await this.#emitOne({
				schema_version: 1,
				id: uuidv5(`unreachable:system-outbox:${now}`),
				type: "bridge.source.unreachable",
				ts: now,
				source: { service: "bridge", host: ".14", agent: null },
				subject: "system-outbox",
				severity: "warn",
				scope: "fleet",
			});
			return;
		}
		for (const e of result.emissions) await this.#emitOne(e);
		if (result.cursor !== "") await this.#setCursor(source, result.cursor);
	}

	start(intervalMs: number): void {
		if (this.#timer) return;
		this.#timer = setInterval(() => {
			void this.pollOnce(new Date().toISOString()).catch(() => undefined);
		}, intervalMs);
		this.#timer.unref();
	}

	stop(): void {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = null;
	}
}
