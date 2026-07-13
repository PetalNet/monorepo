// Service assembly: wires the lake, the serialized appender, the bus broker, and the emit
// pipeline. Importable by both the HTTP server and the tests (drive the real path, no HTTP mock).

import { randomBytes, randomUUID } from "node:crypto";

import { OpenAiCompatibleAssistantCompiler, type AssistantCompiler } from "./assistant/compiler.ts";
import { AssistantRuntime, ClaudeCodeAssistantManager } from "./assistant/runtime.ts";
import { CrackAttentionReconciler } from "./attention/cracks.ts";
import { resolveScopes } from "./auth/principal.ts";
import { TrackerProposalWriter } from "./auth/proposals.ts";
import { uuidv5 } from "./bridge/uuid5.ts";
import { Appender, type AppendResult } from "./bus/appender.ts";
import { Broker } from "./bus/broker.ts";
import { makeReplay } from "./bus/replay.ts";
import { TrackerCommandWriter } from "./commands/tracker.ts";
import { AgentsViewCostMeter, type CostMeter } from "./cost/meter.ts";
import { migrate } from "./db/migrate.ts";
import { openDb, assertRuntimeRolesHardened, type Db } from "./db/pool.ts";
import { parseEmission } from "./emission.ts";
import type { Env } from "./env.ts";
import { authorizeEmission } from "./ingest/authz.ts";
import { loadRegistration } from "./ingest/registrations.ts";
import { scrubEmission } from "./ingest/scrubber.ts";
import { DoormanKeyCeremonyClient } from "./network/key-ceremony.ts";
import { DeliveryService } from "./notifications/delivery.ts";
import { HttpMatrixTransport, type MatrixTransport } from "./notifications/matrix.ts";
import {
	inertExceptionMonitor,
	sanitizedException,
	type ExceptionMonitor,
} from "./observability.ts";
import { Projector } from "./projector/index.ts";
import { TrackerReader, type TrackerProposalLookup } from "./reads/tracker.ts";
import { SignalSourceModes } from "./signals/source-modes.ts";
import { SignalStormDetector } from "./signals/storm.ts";

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
	/** Canonical tracker command RPC; the tracker remains the only lease/task writer. */
	readonly trackerCommands: TrackerCommandWriter | null;
	readonly assistant: AssistantCompiler | null;
	readonly assistantRuntime: AssistantRuntime | null;
	readonly costMeter?: CostMeter;
	readonly delivery: DeliveryService;
	readonly keyCeremony: DoormanKeyCeremonyClient | null;
	readonly sourceModes: SignalSourceModes;
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
	readonly matrixTransport?: MatrixTransport;
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
	const trackerCommands =
		env.trackerRpcUrl && env.trackerRpcToken
			? new TrackerCommandWriter({ url: env.trackerRpcUrl, token: env.trackerRpcToken })
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
	const costMeter = env.costMeterUrl
		? new AgentsViewCostMeter({
				url: env.costMeterUrl,
				...(env.costMeterHostHeader ? { hostHeader: env.costMeterHostHeader } : {}),
				...(env.costMeterToken ? { token: env.costMeterToken } : {}),
			})
		: undefined;
	const keyCeremony =
		env.doormanAdminUrl && env.doormanAdminToken
			? new DoormanKeyCeremonyClient({
					url: env.doormanAdminUrl,
					token: env.doormanAdminToken,
				})
			: null;
	let delivery: DeliveryService | null = null;
	let crackAttention: CrackAttentionReconciler | null = null;
	const appender = new Appender(db.writer, (seq, e, receivedAt) => {
		broker.onEvent(seq, e);
		projector.onEvent(seq, e, receivedAt);
		void crackAttention
			?.enqueue(e)
			.catch((error) =>
				monitor.captureException(
					sanitizedException(error, "crack attention reconciliation failed"),
				),
			);
		void delivery
			?.enqueueEmission(e)
			.catch((error) =>
				monitor.captureException(sanitizedException(error, "delivery dispatch failed")),
			);
	});
	let stormDetector: SignalStormDetector | null = null;
	let stormExpiryTimer: NodeJS.Timeout | null = null;
	let sourceModeOutboxTimer: NodeJS.Timeout | null = null;

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
		// Registration remains the first fence. The only grant exception below is a subscription
		// entity whose owner and private scope agree exactly; all other writes use grant intersection.
		const entity = e.meta?.["entity"];
		const entityOwner =
			entity && typeof entity === "object" && !Array.isArray(entity)
				? (entity as Record<string, unknown>)["owner"]
				: undefined;
		const internalSubscriptionWrite =
			producerSubject === "system:console-api" &&
			e.type === "subscription.changed" &&
			typeof entityOwner === "string" &&
			e.scope === (entityOwner.startsWith("agent:") ? entityOwner : `user:${entityOwner}`);
		const internalOwner = e.dimensions?.["owner"];
		const internalPrivateWrite =
			producerSubject === "system:console-api" &&
			(e.type.startsWith("delivery.") || e.type.startsWith("attention.")) &&
			typeof internalOwner === "string" &&
			e.scope === `user:${internalOwner}`;
		if (!editable.scopes.includes(e.scope) && !internalSubscriptionWrite && !internalPrivateWrite)
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
		if (!result.duplicate && stormDetector) {
			// Detection coalesces bursts internally and stays off the durable append response path.
			void stormDetector
				.observe(e)
				.catch((error) =>
					monitor.captureException(sanitizedException(error, "signal storm detection failed")),
				);
		}
		if (
			e.type === "edge.enroll.request" ||
			e.type === "edge.enroll.approved" ||
			e.type === "edge.enroll.denied"
		) {
			const entity = e.meta?.["entity"];
			const typedEntity =
				entity && typeof entity === "object" && !Array.isArray(entity)
					? (entity as Record<string, unknown>)
					: {};
			const fingerprint = e.dimensions?.["pubkey_fp"] ?? typedEntity["pubkey_fp"];
			if (typeof fingerprint === "string" && fingerprint) {
				const resolved = e.type !== "edge.enroll.request";
				const now = new Date().toISOString();
				const subject = `edge-enroll:${fingerprint}`;
				const attention = {
					schema_version: 1,
					id: uuidv5(`key-ceremony-attention:${e.id}:${resolved ? "resolved" : "opened"}`),
					type: resolved ? "attention.resolved" : "attention.created",
					ts: now,
					source: { service: "console-api", host: null, agent: null },
					subject,
					subject_kind: "other",
					severity: "info",
					action: "/network",
					scope: "fleet",
					dimensions: {
						lane: "admin",
						pubkey_fp: fingerprint,
						...(resolved ? { resolved_via: "auto" } : {}),
					},
					meta: {
						retention_class: "audit",
						entity: resolved
							? { resolved_at: now, resolved_by: "system:key-ceremony", resolved_via: "auto" }
							: {
									schema_version: 1,
									id: subject,
									grade: "review",
									source: "edge.enroll.request",
									subject: "Pending edge enrollment",
									summary: "A device is waiting for an admin to review its doorman key.",
									ts: e.ts,
									scope: "fleet",
									lane: "admin",
									incident_key: subject,
									fix_ops: [],
									resolved_at: null,
								},
					},
				};
				const attentionResult = await emit(
					"system:console-api",
					attention,
					Buffer.byteLength(JSON.stringify(attention)),
				);
				if (!attentionResult.ok)
					monitor.captureException(
						new Error(
							`key ceremony attention emission failed: ${attentionResult.code ?? "unknown"}`,
						),
					);
			}
		}
		return { ok: true, seq: result.seq, duplicate: result.duplicate };
	}

	delivery = new DeliveryService({
		db,
		matrix: opts?.matrixTransport ?? (env.matrix ? new HttpMatrixTransport(env.matrix) : null),
		emit: async (emission) =>
			emit("system:console-api", emission, Buffer.byteLength(JSON.stringify(emission))),
		scopesForOwner: async (owner) => (await resolveScopes(db.admin, owner, [])).scopes,
	});
	const sourceModes = new SignalSourceModes(db.writer, async (emission) =>
		emit("system:console-api", emission, Buffer.byteLength(JSON.stringify(emission))),
	);
	void sourceModes
		.reconcilePending()
		.catch((error) =>
			monitor.captureException(sanitizedException(error, "signal source mode outbox failed")),
		);
	sourceModeOutboxTimer = setInterval(() => {
		void sourceModes
			.reconcilePending()
			.catch((error) =>
				monitor.captureException(sanitizedException(error, "signal source mode outbox failed")),
			);
	}, 30_000);
	sourceModeOutboxTimer.unref();
	crackAttention = new CrackAttentionReconciler(db.writer, async (emission) =>
		emit("system:console-api", emission, Buffer.byteLength(JSON.stringify(emission))),
	);
	await crackAttention.reconcilePersisted();

	stormDetector = new SignalStormDetector(
		db.admin,
		async (emission) =>
			emit("system:console-api", emission, Buffer.byteLength(JSON.stringify(emission))),
		() => new Date(),
		async (owner) => (await resolveScopes(db.admin, owner, [])).scopes,
	);
	stormExpiryTimer = setInterval(() => {
		void stormDetector
			?.reconcileExpired()
			.catch((error) =>
				monitor.captureException(sanitizedException(error, "signal storm expiry failed")),
			);
	}, 30_000);
	stormExpiryTimer.unref();

	return {
		db,
		appender,
		broker,
		projector,
		tracker,
		trackerProposals,
		trackerProposalLookup: tracker,
		trackerCommands,
		assistant,
		assistantRuntime,
		...(costMeter ? { costMeter } : {}),
		delivery,
		keyCeremony,
		sourceModes,
		cursorSecret,
		onGrantChange(listener) {
			grantListeners.add(listener);
			return () => grantListeners.delete(listener);
		},
		emit,
		async close() {
			if (stormExpiryTimer) clearInterval(stormExpiryTimer);
			if (sourceModeOutboxTimer) clearInterval(sourceModeOutboxTimer);
			await crackAttention?.drain();
			await delivery?.drain();
			tracker?.close();
			await grantListen.unlisten();
			await db.close();
		},
	};
}
