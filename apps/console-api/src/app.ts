// Service assembly: wires the lake, the serialized appender, the bus broker, and the emit
// pipeline. Importable by both the HTTP server and the tests (drive the real path, no HTTP mock).

import { Appender, type AppendResult } from "./bus/appender.ts";
import { Broker } from "./bus/broker.ts";
import { makeReplay } from "./bus/replay.ts";
import { migrate } from "./db/migrate.ts";
import { openDb, type Db } from "./db/pool.ts";
import { parseEmission } from "./emission.ts";
import type { Env } from "./env.ts";
import { authorizeEmission } from "./ingest/authz.ts";
import { loadRegistration } from "./ingest/registrations.ts";
import { scrubEmission } from "./ingest/scrubber.ts";

export interface EmitOutcome {
	readonly ok: boolean;
	readonly seq?: number;
	readonly duplicate?: boolean;
	readonly code?: string;
	readonly message?: string;
}

export interface Services {
	readonly db: Db;
	readonly appender: Appender;
	readonly broker: Broker;
	emit(producerSubject: string, raw: unknown, bytes: number): Promise<EmitOutcome>;
	close(): Promise<void>;
}

export async function buildServices(env: Env, opts?: { migrate?: boolean }): Promise<Services> {
	const db = openDb(env);
	if (opts?.migrate !== false) await migrate(db.admin);
	const broker = new Broker(makeReplay(db.app));
	const appender = new Appender(db.admin, (seq, e) => {
		broker.onEvent(seq, e);
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
			result = await appender.append(e);
		} catch (err) {
			return { ok: false, code: "append_failed", message: String(err) };
		}
		return { ok: true, seq: result.seq, duplicate: result.duplicate };
	}

	return {
		db,
		appender,
		broker,
		emit,
		async close() {
			await db.close();
		},
	};
}
