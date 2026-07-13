// Service assembly: wires the lake, the serialized appender, the bus broker, and the emit
// pipeline. Importable by both the HTTP server and the tests (drive the real path, no HTTP mock).

import { randomBytes, randomUUID } from "node:crypto";

import { OpenAiCompatibleAssistantCompiler, type AssistantCompiler } from "./assistant/compiler.ts";
import { AssistantRuntime, ClaudeCodeAssistantManager } from "./assistant/runtime.ts";
import { resolveScopes } from "./auth/principal.ts";
import { TrackerProposalWriter } from "./auth/proposals.ts";
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
import {
	inertExceptionMonitor,
	sanitizedException,
	type ExceptionMonitor,
} from "./observability.ts";
import { Projector } from "./projector/index.ts";
import { TrackerReader, type TrackerProposalLookup } from "./reads/tracker.ts";

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
	readonly trackerProposals: TrackerProposalWriter | null;
	readonly trackerProposalLookup: TrackerProposalLookup | null;
	readonly assistant: AssistantCompiler | null;
	readonly assistantRuntime: AssistantRuntime | null;
	/** Process-local key only in dev; production must supply CONSOLE_API_CURSOR_SECRET. */
	readonly cursorSecret: string;
	onGrantChange(listener: (zookie: string) => void): () => void;
	emit(
		producer: string | { readonly id: string; readonly tiers: readonly string[] },
		raw: unknown,
		bytes: number,
	): Promise<EmitOutcome>;
	close(): Promise<void>;
}

interface ServiceOptions {
	readonly migrate?: boolean;
	readonly monitor?: ExceptionMonitor;
	readonly writeInternalError?: (line: string) => unknown;
}

function boundedErrorClass(error: unknown): string {
	const name = error instanceof Error ? error.constructor.name : "UnknownError";
	return /^[A-Za-z][A-Za-z0-9_$]{0,63}$/.test(name) ? name : "Error";
}

export async function buildServices(env: Env, opts?: ServiceOptions): Promise<Services> {
	if (!env.devAuth && !env.cursorSecret)
		throw new Error("missing required env CONSOLE_API_CURSOR_SECRET");
	const cursorSecret = env.cursorSecret ?? randomBytes(32).toString("base64url");
	const monitor = opts?.monitor ?? inertExceptionMonitor;
	const writeInternalError =
		opts?.writeInternalError ?? ((line: string) => process.stderr.write(line));
	const db = openDb(env);
	if (opts?.migrate !== false) await migrate(db.admin);
	await assertRuntimeRolesHardened(db, env.devAuth);
	const broker = new Broker(makeReplay(db.app));
	const grantListeners = new Set<(zookie: string) => void>();
	const grantListen = await db.admin.listen("console_grants_changed", (zookie) => {
		for (const listener of grantListeners) listener(zookie);
	});
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
	await projector.replayContractedReadsToHead();
	const tracker = env.trackerDbPath ? new TrackerReader(env.trackerDbPath) : null;
	const proposalConfig = [env.trackerRpcUrl, env.trackerRpcToken, env.trackerProposalProject];
	if (proposalConfig.some(Boolean) && !proposalConfig.every(Boolean))
		throw new Error(
			"TRACKER_RPC_URL, TRACKER_RPC_TOKEN, and TRACKER_PROPOSAL_PROJECT must be configured together",
		);
	if (env.trackerRpcUrl && !env.devAuth && new URL(env.trackerRpcUrl).protocol !== "https:")
		throw new Error("TRACKER_RPC_URL must use https outside dev-auth mode");
	if (env.trackerRpcUrl && !tracker)
		throw new Error("TRACKER_DB_PATH is required for idempotent tracker proposal reconciliation");
	const trackerProposals =
		env.trackerRpcUrl && env.trackerRpcToken && env.trackerProposalProject
			? new TrackerProposalWriter({
					url: env.trackerRpcUrl,
					token: env.trackerRpcToken,
					project: env.trackerProposalProject,
				})
			: null;
	const assistant =
		env.assistantLlmUrl && env.assistantLlmModel
			? new OpenAiCompatibleAssistantCompiler({
					url: env.assistantLlmUrl,
					model: env.assistantLlmModel,
					...(env.assistantLlmApiKey !== undefined ? { apiKey: env.assistantLlmApiKey } : {}),
				})
			: null;
	const runtimeConfig = [env.assistantManagerUrl, env.assistantManagerToken, env.publicConsoleUrl];
	if (runtimeConfig.some(Boolean) && !runtimeConfig.every(Boolean))
		throw new Error(
			"CONSOLE_ASSISTANT_MANAGER_URL, CONSOLE_ASSISTANT_MANAGER_TOKEN, and CONSOLE_API_PUBLIC_URL must be configured together",
		);
	if (
		!env.devAuth &&
		[env.assistantManagerUrl, env.publicConsoleUrl].some(
			(value) => value && new URL(value).protocol !== "https:",
		)
	)
		throw new Error(
			"assistant manager and public console URLs must use https outside dev-auth mode",
		);
	const assistantRuntime =
		env.assistantManagerUrl && env.assistantManagerToken && env.publicConsoleUrl
			? new AssistantRuntime(
					db.writer,
					new ClaudeCodeAssistantManager({
						url: env.assistantManagerUrl,
						token: env.assistantManagerToken,
						publicConsoleUrl: env.publicConsoleUrl,
					}),
				)
			: null;
	const appender = new Appender(db.writer, (seq, e, receivedAt) => {
		broker.onEvent(seq, e);
		projector.onEvent(seq, e, receivedAt);
	});

	async function emit(
		producer: string | { readonly id: string; readonly tiers: readonly string[] },
		raw: unknown,
		bytes: number,
	): Promise<EmitOutcome> {
		const producerSubject = typeof producer === "string" ? producer : producer.id;
		const producerTiers = typeof producer === "string" ? [] : producer.tiers;
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
		const editable = await resolveScopes(
			db.admin,
			producerSubject,
			producerTiers,
			["editor", "operator", "owner"],
			false,
		);
		if (!editable.scopes.includes(e.scope))
			return {
				ok: false,
				code: "scope_denied",
				message: "producer lacks an editor grant for the emission scope",
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
			const incidentId = randomUUID();
			const errorClass = boundedErrorClass(err);
			const captured = sanitizedException(err, `append failed; incident ${incidentId}`);
			captured.name = errorClass;
			try {
				monitor.captureException(captured);
			} catch {
				// A telemetry outage must not replace the stable producer-facing append failure.
			}
			try {
				writeInternalError(
					`${JSON.stringify({
						level: "error",
						service: "console-api",
						event: "append_failed",
						incident_id: incidentId,
						error_class: errorClass,
					})}\n`,
				);
			} catch {
				// Keep the API response deterministic even if the local fallback sink is unavailable.
			}
			return { ok: false, code: "append_failed", message: "emission append failed" };
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
		trackerProposals,
		trackerProposalLookup: tracker,
		assistant,
		assistantRuntime,
		cursorSecret,
		onGrantChange(listener) {
			grantListeners.add(listener);
			return () => grantListeners.delete(listener);
		},
		emit,
		async close() {
			tracker?.close();
			await grantListen.unlisten();
			await db.close();
		},
	};
}
