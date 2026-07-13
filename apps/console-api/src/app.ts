// Service assembly: wires the lake, the serialized appender, the bus broker, and the emit
// pipeline. Importable by both the HTTP server and the tests (drive the real path, no HTTP mock).

import { Appender, type AppendResult } from "./bus/appender.ts";
import { Broker } from "./bus/broker.ts";
import { makeReplay } from "./bus/replay.ts";
import { migrate } from "./db/migrate.ts";
import { openDb, assertRuntimeRolesHardened, type Db } from "./db/pool.ts";
import { parseEmission } from "./emission.ts";
import type { Env } from "./env.ts";
import { authorizeEmission } from "./ingest/authz.ts";
import { loadRegistration } from "./ingest/registrations.ts";
import { scrubEmission } from "./ingest/scrubber.ts";
import { Projector } from "./projector/index.ts";
import { TrackerReader } from "./reads/tracker.ts";

export interface EmitOutcome {
	readonly ok: boolean;
	readonly seq?: number;
	readonly duplicate?: boolean;
	readonly code?: string;
	readonly message?: string;
	readonly retryAfterS?: number;
}

export interface Services {
	readonly db: Db;
	readonly appender: Appender;
	readonly broker: Broker;
	readonly projector: Projector;
	/** Read-only tracker access (null when TRACKER_DB_PATH is unset). */
	readonly tracker: TrackerReader | null;
	emit(producerSubject: string, raw: unknown, bytes: number): Promise<EmitOutcome>;
	close(): Promise<void>;
}

export async function buildServices(env: Env, opts?: { migrate?: boolean }): Promise<Services> {
	const db = openDb(env);
	if (opts?.migrate !== false) await migrate(db.admin);
	await assertRuntimeRolesHardened(db, env.devAuth);
	const broker = new Broker(makeReplay(db.app));
	// initialize the bus head from the lake so a post-restart `since:0` subscribe replays persisted
	// history (not just events appended by THIS process) — codex N1a P1.
	const headRow = await db.admin<
		{ n: string }[]
	>`select coalesce(max(seq), 0)::bigint as n from events`;
	broker.setHead(Number(headRow[0]?.n ?? 0));
	// projector: cursored consumer of the lake into current_state. Boot-replay to head BEFORE
	// serving reads, then live off fan-out (N1b). Writes as console_writer (non-superuser).
	const projector = new Projector(db.writer);
	await projector.replayToHead();
	const tracker = env.trackerDbPath ? new TrackerReader(env.trackerDbPath) : null;
	const appender = new Appender(db.writer, (seq, e, receivedAt) => {
		broker.onEvent(seq, e);
		projector.onEvent(seq, e, receivedAt);
	});

	async function emit(producerSubject: string, raw: unknown, bytes: number): Promise<EmitOutcome> {
		const parsed = parseEmission(raw, bytes);
		if (!parsed.ok || !parsed.emission)
			return {
				ok: false,
				code: parsed.code ?? "invalid_emission",
				message: parsed.message ?? "invalid",
			};
		const e = parsed.emission;
		const scrub = scrubEmission(e);
		if (!scrub.ok)
			return {
				ok: false,
				code: "secret_detected",
				message: `secret in ${scrub.where ?? "emission"}`,
			};
		const reg = await loadRegistration(db.admin, producerSubject);
		if (!reg)
			return {
				ok: false,
				code: "unregistered_producer",
				message: `no emit registration for ${producerSubject}`,
			};
		const authz = authorizeEmission(reg, e);
		if (!authz.ok)
			return { ok: false, code: authz.code ?? "emit_denied", message: authz.message ?? "denied" };
		let result: AppendResult;
		try {
			result = await appender.append(e, producerSubject, {
				maxEmitPerMinute: reg.maxEmitPerMinute,
				maxNewTypesPerHour: reg.maxNewTypesPerHour,
			});
		} catch (err) {
			return { ok: false, code: "append_failed", message: String(err) };
		}
		if (!result.ok)
			return {
				ok: false,
				code: result.code,
				message: result.message,
				...(result.retryAfterS ? { retryAfterS: result.retryAfterS } : {}),
			};
		return { ok: true, seq: result.seq, duplicate: result.duplicate };
	}

	return {
		db,
		appender,
		broker,
		projector,
		tracker,
		emit,
		async close() {
			tracker?.close();
			await db.close();
		},
	};
}
