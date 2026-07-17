// The co-located bridge (N1b-3, PHASE1B-DESIGN §3). Tails .14-local as-built sources on a poll and
// emits them into the lake via the normal emit path (authz + scrubber + dedup all apply). Remote
// boxes run their own per-box bridge (the future Rust `console-bridge`); this one covers the
// .14-local sources. Deterministic ids make every poll idempotent; a durable cursor per source
// resumes after restart; an unreadable source emits `bridge.source.unreachable` (a dark source is a
// signal, not an absence).

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Sql } from "../db/pool.ts";
import type { Emission } from "../emission.ts";
import { sourceCursorRef, tailSystemOutbox } from "./system-outbox.ts";
import { uuidv5 } from "./uuid5.ts";

export interface EmitFn {
	(
		producerSubject: string,
		emission: Emission,
		bytes: number,
	): Promise<{ ok: boolean; code?: string }>;
}

const SYSTEM_OUTBOX_PRODUCER = "bridge:system-outbox";

export interface AdapterLoss {
	readonly cursor: string;
	readonly reason: string;
}

export interface AdapterBatch {
	readonly cursor: string;
	readonly emissions: readonly Emission[];
	readonly losses?: readonly AdapterLoss[];
}

/** Common cursor/dead-letter seam for native subsystem snapshots and read-only adapters. */
export interface BridgeAdapter {
	readonly source: string;
	readonly producerSubject: string;
	poll(cursor: string, now: string): AdapterBatch | Promise<AdapterBatch>;
}

export interface BridgeConfig {
	readonly systemOutboxDir?: string | undefined;
	readonly adapters?: readonly BridgeAdapter[] | undefined;
}

interface Cursor {
	readonly cursor: string;
	readonly belowCount: number;
	readonly belowHash: string;
}

export class Bridge {
	readonly #writer: Sql;
	readonly #emit: EmitFn;
	readonly #config: BridgeConfig;
	#timer: ReturnType<typeof setInterval> | null = null;
	#polling = false;
	// Per-source liveness, for emit-on-transition (never per-poll spam during an outage).
	readonly #dark = new Set<string>();
	readonly #healthySeen = new Set<string>();

	constructor(writer: Sql, emit: EmitFn, config: BridgeConfig) {
		this.#writer = writer;
		this.#emit = emit;
		this.#config = config;
	}

	async #cursor(source: string): Promise<Cursor> {
		const sql = this.#writer;
		const rows = await sql<
			{ cursor: string; below_count: number; below_hash: string }[]
		>`select cursor, below_count, below_hash from bridge_cursor where source = ${source}`;
		const row = rows[0];
		return {
			cursor: row?.cursor ?? "",
			belowCount: Number(row?.below_count ?? 0),
			belowHash: row?.below_hash ?? "",
		};
	}

	async #setCursor(source: string, c: Cursor): Promise<void> {
		const sql = this.#writer;
		await sql`insert into bridge_cursor (source, cursor, below_count, below_hash)
			values (${source}, ${c.cursor}, ${c.belowCount}, ${c.belowHash})
			on conflict (source) do update set cursor = excluded.cursor, below_count = excluded.below_count,
				below_hash = excluded.below_hash, updated_at = now()`;
	}

	async #emitOne(producer: string, e: Emission): Promise<void> {
		const r = await this.#emit(producer, e, Buffer.byteLength(JSON.stringify(e)));
		// A rejected emit must NOT be swallowed: throwing here leaves the cursor un-advanced so the
		// next poll re-tails and re-emits (the deterministic id dedups the ones that did land). The
		// tailer only ever produces allowed shapes (bot.message / fleet / <=danger), so ok:false means
		// the producer registration is wrong — a deploy fault we want to surface loudly (a stalled
		// cursor), not a silent whole-feed drop.
		if (!r.ok) throw new Error(`bridge emit rejected: ${r.code ?? "unknown"} (${e.type})`);
	}

	async #quarantine(
		source: string,
		file: string,
		emissionId: string | null,
		code: string,
	): Promise<void> {
		await this.#writer`insert into bridge_dead_letter (source, source_cursor, emission_id, error_code)
			values (${source}, ${file}, ${emissionId}, ${code}) on conflict (source, source_cursor) do nothing`;
	}

	#gap(source: string, file: string, reason: string, ts: string): Emission {
		return {
			...this.#control(source, "bridge.gap_detected", ts, "warn"),
			id: uuidv5(`bridge.gap_detected:${source}:${file}:${reason}`),
			dimensions: { source_cursor: file, reason },
		};
	}

	#tagSource(source: string, emission: Emission): Emission {
		return {
			...emission,
			meta: {
				...emission.meta,
				bridge_source: { kind: "bridge_source", id: source },
			},
		};
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
			meta: { bridge_source: { kind: "bridge_source", id: source } },
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
			for await (const adapter of this.#config.adapters ?? [])
				await this.#pollAdapter(adapter, now);
		} finally {
			this.#polling = false;
		}
	}

	async #pollAdapter(adapter: BridgeAdapter, now: string): Promise<void> {
		const prev = await this.#cursor(adapter.source);
		let batch: AdapterBatch;
		try {
			batch = await adapter.poll(prev.cursor, now);
		} catch {
			if (!this.#dark.has(adapter.source)) {
				this.#dark.add(adapter.source);
				await this.#emitOne(
					adapter.producerSubject,
					this.#control(adapter.source, "bridge.source.unreachable", now, "warn"),
				);
				// The doorman spool is the edge's positive liveness source. Losing it is itself the
				// approved P0 "doorman dark" fact, not merely generic bridge telemetry.
				if (adapter.source === "doorman")
					await this.#emitOne(
						adapter.producerSubject,
						this.#control(adapter.source, "doorman.dark", now, "p0"),
					);
			}
			return;
		}
		const recovered = this.#dark.delete(adapter.source);
		if (recovered) {
			await this.#emitOne(
				adapter.producerSubject,
				this.#control(adapter.source, "bridge.source.recovered", now, "info"),
			);
		}
		// A first healthy read after process restart is positive edge evidence. Emit it even when the
		// in-memory dark bit was lost so a persisted pre-restart doorman P0 can heal.
		if (adapter.source === "doorman" && (recovered || !this.#healthySeen.has(adapter.source)))
			await this.#emitOne(
				adapter.producerSubject,
				this.#control(adapter.source, "doorman.recover", now, "info"),
			);
		this.#healthySeen.add(adapter.source);
		for await (const loss of batch.losses ?? []) {
			const ref = sourceCursorRef(loss.cursor);
			await this.#quarantine(adapter.source, ref, null, loss.reason);
			await this.#emitOne(
				adapter.producerSubject,
				this.#gap(adapter.source, ref, loss.reason, now),
			);
		}
		for await (const raw of batch.emissions) {
			const e = this.#tagSource(adapter.source, raw);
			const r = await this.#emit(adapter.producerSubject, e, Buffer.byteLength(JSON.stringify(e)));
			if (r.ok) continue;
			if (["invalid_emission", "payload_too_large", "secret_detected"].includes(r.code ?? "")) {
				const ref = sourceCursorRef(`${adapter.source}:${e.id}`);
				await this.#quarantine(adapter.source, ref, e.id, r.code ?? "invalid_emission");
				await this.#emitOne(
					adapter.producerSubject,
					this.#gap(adapter.source, ref, r.code ?? "invalid_emission", now),
				);
				continue;
			}
			throw new Error(`bridge emit rejected: ${r.code ?? "unknown"} (${e.type})`);
		}
		if (batch.cursor !== prev.cursor)
			await this.#setCursor(adapter.source, {
				cursor: batch.cursor,
				belowCount: 0,
				belowHash: "",
			});
	}

	async #pollSystemOutbox(dir: string, now: string): Promise<void> {
		const source = "system-outbox";
		const prev = await this.#cursor(source);
		let result;
		try {
			result = tailSystemOutbox(dir, prev.cursor, prev.belowCount, now, prev.belowHash);
		} catch {
			// The source is dark — emit a positive down-signal ONCE on the healthy->dark transition,
			// not every poll (a 5s poll would otherwise mint ~17k duplicate warnings a day).
			if (!this.#dark.has(source)) {
				this.#dark.add(source);
				await this.#emitOne(
					SYSTEM_OUTBOX_PRODUCER,
					this.#control(source, "bridge.source.unreachable", now, "warn"),
				);
			}
			return;
		}
		if (this.#dark.delete(source))
			await this.#emitOne(
				SYSTEM_OUTBOX_PRODUCER,
				this.#control(source, "bridge.source.recovered", now, "info"),
			);
		if (result.anomaly)
			await this.#emitOne(
				SYSTEM_OUTBOX_PRODUCER,
				this.#control(source, "bridge.source.anomaly", now, "warn"),
			);
		for await (const loss of result.losses) {
			const ref = sourceCursorRef(loss.file);
			await this.#quarantine(source, ref, null, loss.reason);
			await this.#emitOne(SYSTEM_OUTBOX_PRODUCER, this.#gap(source, ref, loss.reason, now));
		}
		for await (const raw of result.emissions) {
			const e = this.#tagSource(source, raw);
			const r = await this.#emit(SYSTEM_OUTBOX_PRODUCER, e, Buffer.byteLength(JSON.stringify(e)));
			if (r.ok) continue;
			// Record-level validation/scrubber failures are poison records, not source outages. Keep no
			// secret payload in the DLQ: only the durable source pointer, emission id, and error class.
			if (["invalid_emission", "payload_too_large", "secret_detected"].includes(r.code ?? "")) {
				const ref = String(e.dimensions?.["file_ref"] ?? e.id);
				await this.#quarantine(source, ref, e.id, r.code ?? "invalid_emission");
				await this.#emitOne(
					SYSTEM_OUTBOX_PRODUCER,
					this.#gap(source, ref, r.code ?? "invalid_emission", now),
				);
				continue;
			}
			throw new Error(`bridge emit rejected: ${r.code ?? "unknown"} (${e.type})`);
		}
		if (
			result.cursor !== prev.cursor ||
			result.belowCount !== prev.belowCount ||
			result.belowHash !== prev.belowHash
		)
			await this.#setCursor(source, {
				cursor: result.cursor,
				belowCount: result.belowCount,
				belowHash: result.belowHash,
			});
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

type JsonObject = Record<string, unknown>;

function object(raw: unknown): JsonObject {
	return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as JsonObject) : {};
}

function text(raw: unknown): string | undefined {
	return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function timestamp(raw: unknown, fallback: string): string {
	if (typeof raw === "number" && Number.isFinite(raw)) return new Date(raw * 1000).toISOString();
	const value = text(raw);
	return value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : fallback;
}

function safeFields(raw: unknown): {
	dimensions: Record<string, string | boolean>;
	measures: Record<string, number>;
} {
	const dimensions: Record<string, string | boolean> = {};
	const measures: Record<string, number> = {};
	for (const [key, value] of Object.entries(object(raw)).slice(0, 24)) {
		if (typeof value === "string") dimensions[key] = value.slice(0, 512);
		else if (typeof value === "boolean") dimensions[key] = value;
		else if (typeof value === "number" && Number.isFinite(value)) measures[key] = value;
	}
	return { dimensions, measures };
}

interface SnapshotMark {
	readonly observed: string;
	readonly emitted: string;
	readonly emittedAt: string;
}

function parseSnapshotCursor(cursor: string): Record<string, SnapshotMark> {
	if (!cursor) return {};
	try {
		const marks: Record<string, SnapshotMark> = {};
		for (const [name, raw] of Object.entries(object(JSON.parse(cursor)))) {
			if (typeof raw === "string") marks[name] = { observed: raw, emitted: raw, emittedAt: "" };
			else {
				const mark = object(raw);
				const observed = text(mark["observed"]);
				if (observed)
					marks[name] = {
						observed,
						emitted: text(mark["emitted"]) ?? "",
						emittedAt: text(mark["emittedAt"]) ?? "",
					};
			}
		}
		return marks;
	} catch {
		return {};
	}
}

abstract class SnapshotAdapter implements BridgeAdapter {
	abstract readonly source: string;
	abstract readonly producerSubject: string;
	readonly #dir: string;

	constructor(dir: string) {
		this.#dir = dir;
	}

	protected abstract emissions(
		name: string,
		body: JsonObject,
		hash: string,
		now: string,
	): Emission[];
	protected emissionKey(body: JsonObject, hash: string): string {
		return hash;
	}
	protected shouldEmit(previous: SnapshotMark | undefined, key: string, now: string): boolean {
		return (
			!previous || previous.emitted !== key || previous.emittedAt === "" || now < previous.emittedAt
		);
	}

	poll(cursor: string, now: string): AdapterBatch {
		const previous = parseSnapshotCursor(cursor);
		const next: Record<string, SnapshotMark> = {};
		const emissions: Emission[] = [];
		const losses: AdapterLoss[] = [];
		for (const name of readdirSync(this.#dir)
			.filter((entry) => entry.endsWith(".json"))
			.toSorted()) {
			const path = join(this.#dir, name);
			try {
				const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
				let bytes: Buffer;
				try {
					const stat = fstatSync(fd);
					if (!stat.isFile()) {
						losses.push({ cursor: name, reason: "non_regular" });
						continue;
					}
					if (stat.size > 64 * 1024) {
						losses.push({ cursor: name, reason: "oversize" });
						continue;
					}
					bytes = readRange(fd, 0, stat.size);
				} finally {
					closeSync(fd);
				}
				const hash = createHash("sha256").update(bytes).digest("hex");
				const body = object(JSON.parse(bytes.toString("utf8")));
				const key = this.emissionKey(body, hash);
				const prior = previous[name];
				const emit = this.shouldEmit(prior, key, now);
				if (emit) emissions.push(...this.emissions(name, body, hash, now));
				next[name] = {
					observed: hash,
					emitted: emit ? key : (prior?.emitted ?? ""),
					emittedAt: emit ? now : (prior?.emittedAt ?? ""),
				};
			} catch {
				losses.push({ cursor: name, reason: "invalid_record" });
			}
		}
		return { cursor: JSON.stringify(next), emissions, losses };
	}
}

/** Read-only adapter for lossy `data/fleet/<handle>.json` snapshots. */
export class FleetSnapshotAdapter extends SnapshotAdapter {
	readonly source: string;
	readonly producerSubject = "bridge:fleet";

	constructor(dir: string, source = "fleet") {
		super(dir);
		this.source = source;
	}

	protected emissions(name: string, body: JsonObject, hash: string, now: string): Emission[] {
		const handle = text(body["handle"]);
		const event = text(body["event"]);
		if (!handle || !event) throw new Error(`invalid fleet snapshot: ${name}`);
		const fields = safeFields(body);
		delete fields.dimensions["handle"];
		delete fields.dimensions["event"];
		delete fields.dimensions["host"];
		delete fields.measures["task_id"];
		delete fields.measures["schema_version"];
		return [
			{
				schema_version: 1,
				id: uuidv5(`${this.source}:${name}:${hash}`),
				type: `fleet.event.${event}`,
				ts: timestamp(body["updated_at"], now),
				source: { service: "bridge", host: text(body["host"]) ?? null, agent: handle },
				subject: handle,
				subject_kind: "agent",
				severity: "info",
				task_id: typeof body["task_id"] === "number" ? body["task_id"] : null,
				scope: "fleet",
				...fields,
			},
		];
	}
}

/** Read-only adapter for manager heartbeat snapshots; unchanged 1s rewrites stay quiet. */
export class ManagerHeartbeatAdapter extends SnapshotAdapter {
	readonly source: string;
	readonly producerSubject = "bridge:manager";

	constructor(dir: string, source = "manager") {
		super(dir);
		this.source = source;
	}

	protected override emissionKey(body: JsonObject): string {
		const state = { ...body };
		delete state["updated_at_epoch"];
		return createHash("sha256").update(JSON.stringify(state)).digest("hex");
	}

	protected override shouldEmit(
		previous: SnapshotMark | undefined,
		key: string,
		now: string,
	): boolean {
		if (!previous || previous.emitted !== key || !previous.emittedAt) return true;
		return Date.parse(now) - Date.parse(previous.emittedAt) >= 15_000;
	}

	protected emissions(name: string, body: JsonObject, hash: string, now: string): Emission[] {
		const handle = text(body["handle"]);
		if (!handle) throw new Error(`manager heartbeat lacks handle: ${name}`);
		const fields = safeFields(body);
		for (const key of ["handle", "version", "session_id", "tmux_session", "pane_id"])
			delete fields.dimensions[key];
		delete fields.measures["schema_version"];
		delete fields.measures["updated_at_epoch"];
		const crashed = body["state"] === "crashed";
		const emissions: Emission[] = [
			{
				schema_version: 1,
				id: uuidv5(`${this.source}:${name}:${hash}:heartbeat`),
				type: crashed ? "agent.crashed" : "agent.heartbeat",
				ts: timestamp(body["updated_at_epoch"], now),
				source: { service: "manager", host: null, agent: handle },
				subject: handle,
				subject_kind: "agent",
				severity: crashed ? "danger" : "info",
				scope: "fleet",
				...fields,
			},
		];
		const lock = object(body["channel_lock"]);
		if (lock["state"] === "lockout")
			emissions.push({
				schema_version: 1,
				id: uuidv5(`${this.source}:${name}:${hash}:lockout`),
				type: "channel.lockout",
				ts: timestamp(body["updated_at_epoch"], now),
				source: { service: "manager", host: null, agent: handle },
				subject: handle,
				subject_kind: "agent",
				severity: "danger",
				scope: "fleet",
				dimensions: safeFields(lock).dimensions,
			});
		return emissions;
	}
}

interface SpoolMark {
	readonly line: number;
	readonly byteOffset: number;
	readonly fileId: string;
	readonly tailHash: string;
}

function parseSpoolCursor(cursor: string): Record<string, SpoolMark> {
	try {
		const value = object(JSON.parse(cursor));
		const marks: Record<string, SpoolMark> = {};
		for (const [file, raw] of Object.entries(value)) {
			if (typeof raw === "object" && raw !== null) {
				const mark = object(raw);
				const line = Number(mark["line"]);
				const byteOffset = Number(mark["byteOffset"]);
				if (
					Number.isSafeInteger(line) &&
					line >= 0 &&
					Number.isSafeInteger(byteOffset) &&
					byteOffset >= 0
				)
					marks[file] = {
						line,
						byteOffset,
						fileId: text(mark["fileId"]) ?? "",
						tailHash: text(mark["tailHash"]) ?? "",
					};
			}
		}
		return marks;
	} catch {
		return {};
	}
}

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

const SPOOL_READ_BYTES = 1024 * 1024;
const SPOOL_TAIL_BYTES = 4096;

function readRange(fd: number, start: number, length: number): Buffer {
	const bytes = Buffer.alloc(length);
	let read = 0;
	while (read < length) {
		const count = readSync(fd, bytes, read, length - read, start + read);
		if (count === 0) break;
		read += count;
	}
	return bytes.subarray(0, read);
}

function spoolTailHash(fd: number, offset: number): string {
	const start = Math.max(0, offset - SPOOL_TAIL_BYTES);
	return sha256(readRange(fd, start, offset - start));
}

/** Find the byte immediately after the next newline with fixed-size scratch memory. */
function findLineEnd(fd: number, start: number, size: number): number | null {
	let offset = start;
	while (offset < size) {
		const bytes = readRange(fd, offset, Math.min(64 * 1024, size - offset));
		if (bytes.length === 0) return null;
		const newline = bytes.indexOf(0x0a);
		if (newline >= 0) return offset + newline + 1;
		offset += bytes.length;
	}
	return null;
}

/** Adapter for subsystem-owned append-only JSONL spools (RPC envelope or canonical emission). */
export class JsonlSpoolAdapter implements BridgeAdapter {
	readonly source: string;
	readonly producerSubject: string;
	readonly #dir: string;
	readonly #service: string;

	constructor(source: string, producerSubject: string, service: string, dir: string) {
		this.source = source;
		this.producerSubject = producerSubject;
		this.#service = service;
		this.#dir = dir;
	}

	poll(cursor: string, now: string): AdapterBatch {
		const previous = parseSpoolCursor(cursor);
		const next: Record<string, SpoolMark> = { ...previous };
		const emissions: Emission[] = [];
		const losses: AdapterLoss[] = [];
		for (const file of readdirSync(this.#dir)
			.filter((name) => name.endsWith(".jsonl"))
			.toSorted()) {
			const path = join(this.#dir, file);
			let fd: number;
			try {
				fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ELOOP") {
					losses.push({ cursor: file, reason: "non_regular" });
					continue;
				}
				throw error;
			}
			try {
				const stat = fstatSync(fd);
				if (!stat.isFile()) {
					losses.push({ cursor: file, reason: "non_regular" });
					continue;
				}
				const fileId = `${String(stat.dev)}:${String(stat.ino)}`;
				const prior = previous[file];
				let byteOffset = prior?.byteOffset ?? 0;
				let lineNumber = prior?.line ?? 0;
				if (
					prior &&
					(prior.fileId !== fileId ||
						stat.size < byteOffset ||
						(prior.tailHash !== "" && prior.tailHash !== spoolTailHash(fd, byteOffset)))
				) {
					losses.push({ cursor: `${file}:${String(lineNumber)}`, reason: "cursor_reset" });
					byteOffset = 0;
					lineNumber = 0;
				}
				const available = Math.min(SPOOL_READ_BYTES, Math.max(0, stat.size - byteOffset));
				const bytes = readRange(fd, byteOffset, available);
				const through = bytes.lastIndexOf(0x0a);
				if (through >= 0) {
					const complete = bytes.subarray(0, through + 1).toString("utf8");
					for (const value of complete.split("\n").slice(0, -1)) {
						lineNumber += 1;
						const raw = value.endsWith("\r") ? value.slice(0, -1) : value;
						if (!raw) continue;
						const ref = `${file}:${String(lineNumber)}`;
						try {
							const parsed = object(JSON.parse(raw));
							emissions.push(this.#emission(parsed, ref, now));
						} catch {
							losses.push({ cursor: ref, reason: "invalid_json" });
						}
					}
					byteOffset += through + 1;
				} else if (stat.size - byteOffset > SPOOL_READ_BYTES) {
					const lineEnd = findLineEnd(fd, byteOffset + bytes.length, stat.size);
					if (lineEnd !== null) {
						lineNumber += 1;
						losses.push({ cursor: `${file}:${String(lineNumber)}`, reason: "oversize" });
						byteOffset = lineEnd;
					}
				}
				next[file] = {
					line: lineNumber,
					byteOffset,
					fileId,
					tailHash: spoolTailHash(fd, byteOffset),
				};
			} finally {
				closeSync(fd);
			}
		}
		return { cursor: JSON.stringify(next), emissions, losses };
	}

	#emission(raw: JsonObject, ref: string, now: string): Emission {
		if (raw["schema_version"] === 1 && typeof raw["source"] === "object" && text(raw["type"]))
			return raw as Emission;
		const method = text(raw["method"]);
		const agent = text(raw["agent"]);
		if (!method || !agent) throw new Error("RPC envelope requires method and agent");
		return {
			schema_version: 1,
			id: uuidv5(
				`${this.source}:${ref}:${text(raw["id"]) ?? createHash("sha256").update(JSON.stringify(raw)).digest("hex")}`,
			),
			type: method,
			ts: timestamp(raw["ts"], now),
			source: { service: this.#service, host: null, agent },
			subject: agent,
			subject_kind: "agent",
			severity: method === "governance.action" || method === "discipline.nag" ? "warn" : "info",
			task_id: typeof raw["task_id"] === "number" ? raw["task_id"] : null,
			scope: "fleet",
			...safeFields(raw["payload"]),
		};
	}
}

interface DispatcherCursor {
	readonly updatedAt: number;
	readonly fingerprints: readonly string[];
}

function parseDispatcherCursor(cursor: string): DispatcherCursor {
	try {
		const value = object(JSON.parse(cursor));
		return {
			updatedAt: Number(value["updatedAt"] ?? 0),
			fingerprints: Array.isArray(value["fingerprints"])
				? value["fingerprints"].filter((item): item is string => typeof item === "string")
				: [],
		};
	} catch {
		return { updatedAt: 0, fingerprints: [] };
	}
}

/** Read-only dispatcher card-state adapter; never opens the dispatcher database for writes. */
export class DispatcherSqliteAdapter implements BridgeAdapter {
	readonly source = "dispatcher";
	readonly producerSubject = "bridge:dispatcher";
	readonly #dbPath: string;

	constructor(dbPath: string) {
		this.#dbPath = dbPath;
	}

	poll(cursor: string, now: string): AdapterBatch {
		const previous = parseDispatcherCursor(cursor);
		const db = new DatabaseSync(this.#dbPath, { readOnly: true });
		try {
			const rows = db
				.prepare(
					`select card_id, task_id, sender, sender_class, recipient, priority, thread, body,
						requires_reply, interrupt_policy, needs, state, claimed_by, fence, reaps,
						reply_to, parent_id, delivered, addressed, created_at_ms, updated_at_ms
					 from cards
						 where updated_at_ms >= ?
						 order by updated_at_ms asc, card_id asc`,
				)
				.all(previous.updatedAt) as JsonObject[];
			const fingerprints = new Map<JsonObject, string>();
			for (const row of rows)
				fingerprints.set(
					row,
					sha256(
						JSON.stringify([
							row["card_id"],
							row["updated_at_ms"],
							row["state"],
							row["claimed_by"],
							row["fence"],
							row["reaps"],
							row["delivered"],
							row["addressed"],
						]),
					),
				);
			const seen = new Set(previous.fingerprints);
			const freshRows = rows.filter(
				(row) =>
					Number(row["updated_at_ms"]) > previous.updatedAt ||
					!seen.has(fingerprints.get(row) ?? ""),
			);
			const emissions = freshRows.flatMap((row) => {
				const cardId = text(row["card_id"]);
				const state = text(row["state"]);
				if (!cardId || !state) throw new Error("dispatcher card row lacks card_id/state");
				const priority = Number(row["priority"] ?? 3);
				const stateEmission = {
					schema_version: 1 as const,
					id: uuidv5(`dispatcher:${fingerprints.get(row) ?? ""}`),
					type: "card.state_changed",
					ts: new Date(Number(row["updated_at_ms"]) || Date.parse(now)).toISOString(),
					source: { service: "dispatcher", host: ".14", agent: null },
					subject: cardId,
					subject_kind: "card" as const,
					severity: (priority === 0
						? "danger"
						: priority === 1
							? "warn"
							: "info") as Emission["severity"],
					task_id: Number(row["task_id"]),
					scope: "fleet",
					dimensions: {
						state,
						sender: String(row["sender"] ?? ""),
						sender_class: String(row["sender_class"] ?? ""),
						recipient: String(row["recipient"] ?? ""),
						interrupt_policy: String(row["interrupt_policy"] ?? ""),
						claimed_by: String(row["claimed_by"] ?? ""),
						delivered: Boolean(row["delivered"]),
						addressed: Boolean(row["addressed"]),
					},
					measures: {
						priority,
						fence: Number(row["fence"] ?? 0),
						reaps: Number(row["reaps"] ?? 0),
					},
				} satisfies Emission;
				const sender = text(row["sender"]);
				const recipient = text(row["recipient"]);
				if (!sender || !recipient) return [stateEmission];
				const thread = text(row["thread"]);
				const replyTo = text(row["reply_to"]);
				const body = text(row["body"]);
				const correspondence = {
					schema_version: 1 as const,
					id: uuidv5(`dispatcher:comms:${cardId}`),
					type: "comms.card",
					ts: new Date(Number(row["created_at_ms"]) || Date.parse(now)).toISOString(),
					source: { service: "dispatcher", host: ".14", agent: sender },
					subject: recipient,
					subject_kind: "agent" as const,
					severity: (priority === 0
						? "danger"
						: priority === 1
							? "warn"
							: "info") as Emission["severity"],
					task_id: Number(row["task_id"]),
					scope: "fleet",
					dimensions: {
						method: "task.dispatch",
						card_id: cardId,
						recipient,
						requires_reply: Boolean(row["requires_reply"]),
						...(thread ? { thread } : {}),
						...(replyTo ? { in_reply_to: replyTo } : {}),
					},
					meta: {
						body_preview: body?.slice(0, 240) ?? null,
						sender_class: String(row["sender_class"] ?? ""),
						priority,
					},
				} satisfies Emission;
				return [stateEmission, correspondence];
			});
			const maxUpdatedAt = rows.reduce(
				(max, row) => Math.max(max, Number(row["updated_at_ms"])),
				previous.updatedAt,
			);
			const boundaryFingerprints = rows
				.filter((row) => Number(row["updated_at_ms"]) === maxUpdatedAt)
				.map((row) => fingerprints.get(row) ?? "");
			if (maxUpdatedAt === previous.updatedAt) boundaryFingerprints.push(...previous.fingerprints);
			return {
				cursor: JSON.stringify({
					updatedAt: maxUpdatedAt,
					fingerprints: [...new Set(boundaryFingerprints)].toSorted(),
				}),
				emissions,
			};
		} finally {
			db.close();
		}
	}
}
