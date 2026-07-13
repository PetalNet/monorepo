import { randomUUID } from "node:crypto";

import { matchPattern } from "../bus/broker.ts";
import type { Db } from "../db/pool.ts";
import type { Emission } from "../emission.ts";
import { MatrixDeliveryError, type MatrixTransport } from "./matrix.ts";

type EmitInternal = (emission: Emission) => Promise<{ ok: boolean; code?: string; seq?: number }>;

interface DeliveryConfigRow {
	owner: string;
	scope: string;
	target: string;
	cocoon_until: string | null;
}

interface ReceiptRow {
	seq: string;
	ts: string;
	subject: string;
	dimensions: Record<string, string | boolean>;
}

export interface DeliveryOperationResult {
	readonly receipt_ref?: string;
	readonly delivered?: boolean;
	readonly target?: string;
	readonly cocoon_until?: string | null;
	readonly event_id?: string;
}

const TEST_BODY = "Test from the lab. If you can read this, the line works.";

function isSafetyException(emission: Emission): boolean {
	return emission.severity === "p0" || emission.dimensions?.["interrupt_policy"] === "safety";
}

function filterMatches(filter: unknown, emission: Emission): boolean {
	if (!filter || typeof filter !== "object" || Array.isArray(filter)) return true;
	const fields = filter as Record<string, unknown>;
	if (
		typeof fields["source_service"] === "string" &&
		fields["source_service"] !== emission.source.service
	)
		return false;
	if (typeof fields["subject"] === "string" && fields["subject"] !== emission.subject) return false;
	if (typeof fields["severity_gte"] === "string") {
		const grades = ["debug", "info", "warn", "danger", "p0"];
		if (grades.indexOf(emission.severity) < grades.indexOf(fields["severity_gte"])) return false;
	}
	return true;
}

function isInterruptEligible(emission: Emission): boolean {
	return (
		isSafetyException(emission) || emission.dimensions?.["interrupt_policy"] === "principal_command"
	);
}

export class DeliveryService {
	readonly #db: Db;
	readonly #matrix: MatrixTransport | null;
	readonly #emit: EmitInternal;
	readonly #scopesForOwner: (owner: string) => Promise<readonly string[]>;
	#dispatchTail: Promise<void> = Promise.resolve();

	constructor(options: {
		db: Db;
		matrix: MatrixTransport | null;
		emit: EmitInternal;
		scopesForOwner: (owner: string) => Promise<readonly string[]>;
	}) {
		this.#db = options.db;
		this.#matrix = options.matrix;
		this.#emit = options.emit;
		this.#scopesForOwner = options.scopesForOwner;
	}

	/** Preserve durable bus order and prevent a burst from creating unbounded concurrent sends. */
	enqueueEmission(emission: Emission): Promise<void> {
		const run = this.#dispatchTail.then(() => this.onEmission(emission));
		this.#dispatchTail = run.catch(() => undefined);
		return run;
	}

	drain(): Promise<void> {
		return this.#dispatchTail;
	}

	#transport(): MatrixTransport {
		if (!this.#matrix)
			throw new MatrixDeliveryError(
				"matrix_unconfigured",
				"Matrix delivery is not configured on console-api",
				true,
			);
		return this.#matrix;
	}

	async #config(owner: string): Promise<DeliveryConfigRow | null> {
		const rows = await this.#db.writer<DeliveryConfigRow[]>`
			select owner, scope, target, cocoon_until from delivery_config where owner = ${owner}`;
		return rows[0] ?? null;
	}

	async #emitRequired(emission: Emission): Promise<number> {
		const result = await this.#emit(emission);
		if (!result.ok || result.seq === undefined)
			throw new MatrixDeliveryError(
				result.code ?? "receipt_unavailable",
				"Delivery outcome could not be persisted",
				true,
			);
		return result.seq;
	}

	async #recordReceipt(input: {
		owner: string;
		tier: string;
		signalRef: string;
		subject: string;
		status: "delivered" | "failed";
		errorCode?: string;
		retryable?: boolean;
		eventId?: string;
		body?: string;
	}): Promise<string> {
		const id = randomUUID();
		const ts = new Date().toISOString();
		const seq = await this.#emitRequired({
			schema_version: 1,
			id,
			type: "delivery.receipt",
			ts,
			source: { service: "console-api", host: null, agent: null },
			subject: input.subject,
			subject_kind: "other",
			severity: input.status === "failed" ? "danger" : "info",
			scope: `user:${input.owner}`,
			dimensions: {
				owner: input.owner,
				tier: input.tier,
				signal_ref: input.signalRef,
				status: input.status,
				channel: "matrix",
				...(input.errorCode ? { error_code: input.errorCode } : {}),
				...(input.retryable !== undefined ? { retryable: input.retryable } : {}),
				...(input.eventId ? { event_id: input.eventId } : {}),
				...(input.body ? { body: input.body.slice(0, 512) } : {}),
			},
			meta: { retention_class: "audit" },
		});
		await this.#reconcileAttention(input.owner, input.status, ts);
		return String(seq);
	}

	async #reconcileAttention(
		owner: string,
		status: "delivered" | "failed",
		now: string,
	): Promise<void> {
		const subject = `delivery-line:${owner}`;
		if (status === "delivered") {
			const active = await this.#db.writer<{ active: boolean }[]>`
				select exists(select 1 from current_state where kind = 'attention' and subject = ${subject}
				  and state->>'resolved_at' is null) as active`;
			if (active[0]?.active !== true) return;
			await this.#emitRequired({
				schema_version: 1,
				id: randomUUID(),
				type: "attention.resolved",
				ts: now,
				source: { service: "console-api", host: null, agent: null },
				subject,
				subject_kind: "other",
				severity: "info",
				scope: `user:${owner}`,
				dimensions: { owner, resolved_via: "auto" },
				meta: {
					retention_class: "audit",
					entity: { resolved_at: now, resolved_by: "system:delivery", resolved_via: "auto" },
				},
			});
			return;
		}
		const rows = await this.#db.writer<ReceiptRow[]>`
			select seq, ts, subject, dimensions from events
			where type = 'delivery.receipt' and scope = ${`user:${owner}`}
			  and ts >= now() - interval '10 minutes'
			order by seq desc limit 2`;
		if (rows.length < 2 || rows.some((row) => row.dimensions["status"] !== "failed")) return;
		const failingSince = [...rows].sort((left, right) => left.ts.localeCompare(right.ts))[0]!.ts;
		await this.#createAttention(owner, now, failingSince, "delivery.failed");
	}

	async #createAttention(
		owner: string,
		now: string,
		failingSince: string,
		source: string,
	): Promise<void> {
		const subject = `delivery-line:${owner}`;
		const active = await this.#db.writer<{ active: boolean }[]>`
			select exists(select 1 from current_state where kind = 'attention' and subject = ${subject}
			  and state->>'resolved_at' is null) as active`;
		if (active[0]?.active === true) return;
		await this.#emitRequired({
			schema_version: 1,
			id: randomUUID(),
			type: "attention.created",
			ts: now,
			source: { service: "console-api", host: null, agent: null },
			subject,
			subject_kind: "other",
			severity: "p0",
			action: "/signals?pane=delivery",
			scope: `user:${owner}`,
			dimensions: { owner, incident_key: subject, failing_since: failingSince },
			meta: {
				retention_class: "audit",
				entity: {
					schema_version: 1,
					id: subject,
					grade: "p0",
					source,
					subject: "Matrix interrupt delivery",
					summary:
						"Matrix delivery failing. Interrupts are not reaching you; the console is the backup channel.",
					ts: failingSince,
					scope: `user:${owner}`,
					incident_key: subject,
					fix_ops: [{ op: "delivery.test", args: {} }],
					resolved_at: null,
				},
			},
		});
	}

	/** Consolidate a stale manager/Matrix sync signal into the same stable line incident. */
	async reconcileMatrixSync(matrixSyncOkEpoch: number | null): Promise<void> {
		if (matrixSyncOkEpoch === null || Date.now() / 1_000 - matrixSyncOkEpoch <= 120) return;
		const configs = await this.#db.writer<{ owner: string }[]>`select owner from delivery_config`;
		const now = new Date().toISOString();
		const failingSince = new Date(matrixSyncOkEpoch * 1_000 + 120_000).toISOString();
		await Promise.allSettled(
			configs.map((config) =>
				this.#createAttention(config.owner, now, failingSince, "delivery.sync_stale"),
			),
		);
	}

	async #send(input: {
		owner: string;
		target: string;
		body: string;
		tier: string;
		signalRef: string;
		subject: string;
	}): Promise<DeliveryOperationResult> {
		let receipt: Awaited<ReturnType<MatrixTransport["send"]>>;
		try {
			receipt = await this.#transport().send(input.owner, input.target, input.body, randomUUID());
		} catch (error) {
			const matrixError =
				error instanceof MatrixDeliveryError
					? error
					: new MatrixDeliveryError("matrix_send_failed", "Matrix send failed", true);
			await this.#recordReceipt({
				...input,
				status: "failed",
				errorCode: matrixError.code,
				retryable: matrixError.retryable,
			});
			throw matrixError;
		}
		const receiptRef = await this.#recordReceipt({
			...input,
			status: "delivered",
			eventId: receipt.eventId,
		});
		return { receipt_ref: receiptRef, delivered: true, event_id: receipt.eventId };
	}

	async test(owner: string): Promise<DeliveryOperationResult> {
		const config = await this.#config(owner);
		if (!config)
			throw new MatrixDeliveryError("target_missing", "No Matrix target is configured", false);
		return this.#send({
			owner,
			target: config.target,
			body: TEST_BODY,
			tier: "test",
			signalRef: "delivery.test",
			subject: "Test from the lab.",
		});
	}

	async setTarget(owner: string, target: string): Promise<DeliveryOperationResult> {
		await this.#transport().assertOwnedTarget(owner, target);
		const result = await this.#send({
			owner,
			target,
			body: TEST_BODY,
			tier: "test",
			signalRef: "delivery.set_target",
			subject: "Test from the lab.",
		});
		const now = new Date().toISOString();
		await this.#db.writer`
			insert into delivery_config
				(owner, scope, channel, target, verified, cocoon_until, updated_at, updated_by)
			values (${owner}, ${`user:${owner}`}, 'matrix', ${target}, true, null, ${now}, ${owner})
			on conflict (owner) do update set target = excluded.target, verified = true,
				updated_at = excluded.updated_at, updated_by = excluded.updated_by`;
		return { ...result, target };
	}

	async cocoon(owner: string, until: string): Promise<DeliveryOperationResult> {
		const parsed = Date.parse(until);
		if (!Number.isFinite(parsed))
			throw new MatrixDeliveryError("invalid_until", "Cocoon expiry is not a valid time", false);
		const config = await this.#config(owner);
		if (!config)
			throw new MatrixDeliveryError("target_missing", "No Matrix target is configured", false);
		const cocoonUntil = parsed <= Date.now() ? null : new Date(parsed).toISOString();
		const now = new Date().toISOString();
		await this.#db.writer`
			update delivery_config set cocoon_until = ${cocoonUntil}, updated_at = ${now},
				updated_by = ${owner} where owner = ${owner}`;
		await this.#emitRequired({
			schema_version: 1,
			id: randomUUID(),
			type: "delivery.cocoon_changed",
			ts: now,
			source: { service: "console-api", host: null, agent: null },
			subject: owner,
			subject_kind: "user",
			severity: "info",
			scope: `user:${owner}`,
			dimensions: {
				owner,
				active: cocoonUntil !== null,
				until: cocoonUntil ?? now,
				safety_exception: true,
				p0_exception: true,
			},
			meta: { retention_class: "audit" },
		});
		return { cocoon_until: cocoonUntil };
	}

	async resend(owner: string, receiptRef: string): Promise<DeliveryOperationResult> {
		const rows = await this.#db.writer<ReceiptRow[]>`
			select seq, ts, subject, dimensions from events where seq::text = ${receiptRef}
			  and type = 'delivery.receipt' and scope = ${`user:${owner}`} limit 1`;
		const receipt = rows[0];
		if (!receipt)
			throw new MatrixDeliveryError("scope_denied", "Receipt is not visible to this line", false);
		if (receipt.dimensions["status"] !== "failed" || receipt.dimensions["retryable"] !== true)
			throw new MatrixDeliveryError("not_retryable", "Receipt is not retryable", false);
		const config = await this.#config(owner);
		if (!config)
			throw new MatrixDeliveryError("target_missing", "No Matrix target is configured", false);
		return this.#send({
			owner,
			target: config.target,
			body: String(receipt.dimensions["body"] ?? receipt.subject),
			tier: String(receipt.dimensions["tier"] ?? "interrupt"),
			signalRef: String(receipt.dimensions["signal_ref"] ?? "delivery.resend"),
			subject: receipt.subject,
		});
	}

	/** Route interrupt-tier and loud subscriptions from the durable emitter into Matrix. */
	async onEmission(emission: Emission): Promise<void> {
		if (
			emission.type.startsWith("delivery.") ||
			emission.type.startsWith("attention.") ||
			emission.type.startsWith("audit.") ||
			emission.type.startsWith("console.api.")
		)
			return;
		const rows = await this.#db.admin<
			{ state: Record<string, unknown>; owner: string }[]
		>`select state, state->>'owner' as owner from current_state where kind = 'subscription'
		  and (state->>'tier' = 'interrupt' or coalesce((state->>'loud')::boolean, false))`;
		const owners = new Map<string, { tier: string }>();
		for (const row of rows) {
			const pattern = String(row.state["pattern"] ?? "");
			const tier = String(row.state["tier"] ?? "feed");
			const loud = row.state["loud"] === true;
			if (
				!pattern ||
				!matchPattern(pattern, emission.type) ||
				!filterMatches(row.state["filter"], emission)
			)
				continue;
			if (!loud && (tier !== "interrupt" || !isInterruptEligible(emission))) continue;
			owners.set(row.owner, { tier: tier === "interrupt" ? "interrupt" : "loud" });
		}
		if (owners.size === 0) return;
		await Promise.allSettled(
			[...owners].map(async ([owner, subscription]) => {
				const initialScopes = await this.#scopesForOwner(owner);
				if (!initialScopes.includes(emission.scope)) return;
				const config = await this.#config(owner);
				if (!config) {
					await this.#recordReceipt({
						owner,
						tier: subscription.tier,
						signalRef: emission.type,
						subject: emission.subject,
						body: `${emission.type} — ${emission.subject}`,
						status: "failed",
						errorCode: "target_missing",
						retryable: false,
					});
					return;
				}
				const cocoonActive =
					config.cocoon_until !== null && Date.parse(config.cocoon_until) > Date.now();
				if (cocoonActive && !isSafetyException(emission)) return;
				// This is deliberately the final check before transport I/O.
				const scopes = await this.#scopesForOwner(owner);
				if (!scopes.includes(emission.scope)) return;
				const sourceModes = await this.#db.writer<
					{ source_service: string; mode: "development" | "normal" }[]
				>`select source_service, mode from signal_source_modes
				  where source_service = ${emission.source.service} and mode = 'development' limit 1`;
				if (sourceModes.length > 0) return;
				await this.#send({
					owner,
					target: config.target,
					body: `${emission.type} — ${emission.subject}`,
					tier: subscription.tier,
					signalRef: emission.type,
					subject: emission.subject,
				});
			}),
		);
	}
}
