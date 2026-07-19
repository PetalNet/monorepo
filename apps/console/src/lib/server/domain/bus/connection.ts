// Transport-agnostic bus connection (contract §4.1). The exact per-connection behavior of the
// former Fastify WS handler: ready-principal resolution, heartbeat, grant-change re-fencing,
// frame-contract validation, and bounded subscription bookkeeping. The WebSocket (or any other
// framed transport) is abstracted behind BusSocket so the upgrade path owns no bus semantics.
import {
	CONTRACTS_DIR,
	readSchema,
	validateJsonSchema,
	type JsonSchema,
} from "../../api/json-schema.ts";
import type { Principal } from "../auth/principal.ts";
import { withScopes } from "../db/pool.ts";
import { sanitizedException, type ExceptionMonitor } from "../observability.ts";
import type { Services } from "../substrate.ts";
import type { SubscribeSpec } from "./broker.ts";

const busFrameSchema = readSchema(new URL("schemas/bus-frame.schema.json", CONTRACTS_DIR));
const clientBusFrameSchema: JsonSchema = {
	oneOf: [{ $ref: "#/$defs/subscribe" }, { $ref: "#/$defs/unsubscribe" }],
};

export interface BusSocket {
	send(text: string): void;
	close(): void;
	isOpen(): boolean;
	onMessage(handler: (data: string | Uint8Array) => void): void;
	onClose(handler: () => void): void;
}

export interface BusCounters {
	clients: number;
	subscriptions: number;
}

export interface BusConnectionOptions {
	services: Services;
	monitor: ExceptionMonitor;
	/** Re-resolves the connection's principal from its original credentials. */
	resolvePrincipal: () => Promise<Principal | null>;
	/** Whether credentials can be re-resolved (bearer or session auth present). */
	refreshable: boolean;
	counters: BusCounters;
}

export function attachBusConnection(socket: BusSocket, options: BusConnectionOptions): void {
	const { services, monitor, resolvePrincipal, refreshable, counters } = options;
	const maxFrameBytes = 16 * 1024;
	const maxSubscriptions = 64;
	const connectionId = crypto.randomUUID();
	counters.clients += 1;
	let clientCounted = true;
	let principal: Principal | null = null;
	const connSubs = new Set<string>();
	const removeConnSub = (subId: string): void => {
		if (connSubs.delete(subId)) counters.subscriptions = Math.max(0, counters.subscriptions - 1);
	};
	const send = (frame: Record<string, unknown>): void => {
		if (frame["kind"] === "resync_required" && typeof frame["sub_id"] === "string")
			removeConnSub(frame["sub_id"]);
		if (socket.isOpen()) socket.send(JSON.stringify(frame));
	};
	const ready = (async () => {
		try {
			principal = await resolvePrincipal();
		} catch {
			principal = null;
		}
		if (!principal) {
			send({
				schema_version: 1,
				kind: "ack",
				sub_id: "*",
				replay_through_seq: 0,
				error: { code: "unauthorized", message: "valid credentials required", retryable: false },
			});
			socket.close();
		}
	})();
	let heartbeatRunning = false;
	const sendHeartbeat = async (): Promise<void> => {
		if (!principal || heartbeatRunning || !socket.isOpen()) return;
		heartbeatRunning = true;
		const ts = new Date();
		let ingest: Record<string, number> | null = null;
		try {
			const rows = await withScopes(
				services.db.app,
				principal.scopes,
				async (tx) =>
					tx<{ source_service: string; last_received_at: string }[]>`
					select source_service, max(received_at)::text as last_received_at
					from events
					group by source_service`,
			);
			ingest = Object.fromEntries(
				rows.map((row) => [
					row.source_service,
					Math.max(0, (ts.getTime() - Date.parse(row.last_received_at)) / 1000),
				]),
			);
		} catch (error) {
			monitor.captureException(sanitizedException(error));
		} finally {
			heartbeatRunning = false;
		}
		send({
			schema_version: 1,
			kind: "heartbeat",
			ts: ts.toISOString(),
			seq_head: services.broker.head,
			ingest,
		});
	};
	void ready.then(sendHeartbeat);
	const heartbeatTimer = setInterval(() => {
		void sendHeartbeat();
	}, 15000);
	heartbeatTimer.unref();

	// LISTEN/NOTIFY makes grant changes re-fence immediately. The 30s check remains as a recovery
	// path for token revocation and a notification connection blip.
	let refreshing = false;
	let refreshAgain = false;
	const refreshPrincipal = async (): Promise<void> => {
		if (refreshing) {
			refreshAgain = true;
			return;
		}
		refreshing = true;
		try {
			const fresh = await resolvePrincipal();
			if (!fresh) {
				for (const id of connSubs) services.broker.unsubscribe(connectionId, id);
				socket.close();
				return;
			}
			principal = fresh;
			services.broker.revalidateScopes(connectionId, [...connSubs], fresh.scopes);
		} catch {
			/* transient DB blip: keep the connection, retry on the fallback timer */
		} finally {
			refreshing = false;
			if (refreshAgain && socket.isOpen()) {
				refreshAgain = false;
				void refreshPrincipal();
			}
		}
	};
	const stopGrantWatch = refreshable
		? services.onGrantChange(() => {
				principal = null;
				services.broker.revalidateScopes(connectionId, [...connSubs], []);
				void refreshPrincipal();
			})
		: null;
	const revalidateTimer = refreshable
		? setInterval(() => {
				void refreshPrincipal();
			}, 30000)
		: null;
	if (revalidateTimer) revalidateTimer.unref();

	socket.onMessage((data: string | Uint8Array) => {
		void (async () => {
			await ready;
			if (!principal) return;
			const rejectFrame = (code: string, message: string, subId = "?"): void => {
				send({
					schema_version: 1,
					kind: "ack",
					sub_id: subId,
					replay_through_seq: services.broker.head,
					error: { code, message, retryable: false },
				});
			};
			const frameBytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
			if (frameBytes > maxFrameBytes) {
				rejectFrame("frame_too_large", `frame exceeds ${String(maxFrameBytes)} bytes`);
				return;
			}
			let raw: unknown;
			try {
				raw = JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString()) as unknown;
			} catch {
				rejectFrame("bad_frame", "invalid json");
				return;
			}
			const rawSubId =
				raw && typeof raw === "object" ? (raw as Record<string, unknown>)["sub_id"] : undefined;
			const candidateSubId = typeof rawSubId === "string" && rawSubId.length <= 64 ? rawSubId : "?";
			const contractError = validateJsonSchema(raw, clientBusFrameSchema, "frame", busFrameSchema);
			if (contractError) {
				rejectFrame("invalid_frame", "frame does not match the bus contract", candidateSubId);
				return;
			}
			const msg = raw as {
				schema_version: 1;
				action: "subscribe" | "unsubscribe";
				sub_id: string;
				pattern?: string;
				filter?: SubscribeSpec["filter"];
				since?: number;
			};
			if (msg.action === "subscribe") {
				if (!connSubs.has(msg.sub_id) && connSubs.size >= maxSubscriptions) {
					rejectFrame(
						"subscription_limit",
						`connection is limited to ${String(maxSubscriptions)} subscriptions`,
						msg.sub_id,
					);
					return;
				}
				const spec: SubscribeSpec = {
					subId: msg.sub_id,
					pattern: msg.pattern as string,
					filter: msg.filter,
					since: msg.since,
					scopes: principal.scopes,
				};
				await services.broker.subscribe(connectionId, spec, send, () => {
					if (!connSubs.has(msg.sub_id)) {
						connSubs.add(msg.sub_id);
						counters.subscriptions += 1;
					}
				});
			} else {
				services.broker.unsubscribe(connectionId, msg.sub_id);
				removeConnSub(msg.sub_id);
			}
		})();
	});
	socket.onClose(() => {
		if (clientCounted) {
			clientCounted = false;
			counters.clients = Math.max(0, counters.clients - 1);
		}
		clearInterval(heartbeatTimer);
		if (revalidateTimer) clearInterval(revalidateTimer);
		stopGrantWatch?.();
		for (const id of connSubs) services.broker.unsubscribe(connectionId, id);
		counters.subscriptions = Math.max(0, counters.subscriptions - connSubs.size);
		connSubs.clear();
	});
}
