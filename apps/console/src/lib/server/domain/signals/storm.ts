import { uuidv5 } from "../bridge/uuid5.ts";
import { matchPattern } from "../bus/broker.ts";
import type { Sql } from "../db/pool.ts";
import type { Emission } from "../emission.ts";
import { doWhileCondition } from "../iteration.ts";

const SIGNAL_STORM_THRESHOLD = 60;
const SIGNAL_STORM_WINDOW_MS = 5 * 60 * 1_000;
const SIGNAL_STORM_MUTE_MS = 60 * 60 * 1_000;

export interface StormOverride {
	readonly active: boolean;
	readonly event_count: number;
	readonly threshold: number;
	readonly window_started_at: string;
	readonly muted_at: string;
	readonly expires_at: string;
	readonly previous_tier: "feed";
	readonly muted_by: "system:bus";
	readonly undone_at?: string;
	readonly undone_by?: string;
}

interface SubscriptionRow {
	readonly subject: string;
	readonly scope: string;
	readonly state: Record<string, unknown>;
}

interface EventCountRow {
	readonly type: string;
	readonly scope: string;
	readonly severity: string;
	readonly source_service: string;
	readonly subject: string;
	readonly n: string;
}

type InternalEmit = (emission: Emission) => Promise<{ readonly ok: boolean }>;
type ResolveOwnerScopes = (owner: string) => Promise<readonly string[]>;

/** Exactly the broker matcher, including the historical trailing `.*` remainder shorthand. */
const signalPatternMatches = matchPattern;

function filterMatches(state: Record<string, unknown>, row: EventCountRow): boolean {
	const filter = state["filter"];
	if (!filter || typeof filter !== "object" || Array.isArray(filter)) return true;
	const fields = filter as Record<string, unknown>;
	if (
		typeof fields["source_service"] === "string" &&
		fields["source_service"] !== row.source_service
	)
		return false;
	if (typeof fields["subject"] === "string" && fields["subject"] !== row.subject) return false;
	if (typeof fields["severity_gte"] === "string") {
		const grades = ["debug", "info", "warn", "danger", "p0"];
		if (grades.indexOf(row.severity) < grades.indexOf(fields["severity_gte"])) return false;
	}
	return true;
}

function stormCount(
	pattern: string,
	state: Record<string, unknown>,
	rows: readonly EventCountRow[],
	readableScopes?: readonly string[],
): number {
	return rows.reduce(
		(total, row) =>
			total +
			(signalPatternMatches(pattern, row.type) &&
			filterMatches(state, row) &&
			(!readableScopes || readableScopes.includes(row.scope))
				? Number(row.n)
				: 0),
		0,
	);
}

function stormSubscriptionEmission(row: SubscriptionRow, count: number, now: Date): Emission {
	const pattern = String(row.state["pattern"]);
	const owner = String(row.state["owner"]);
	const mutedAt = now.toISOString();
	const windowStartedAt = new Date(now.getTime() - SIGNAL_STORM_WINDOW_MS).toISOString();
	const bucket = Math.floor(now.getTime() / SIGNAL_STORM_WINDOW_MS);
	const storm: StormOverride = {
		active: true,
		event_count: count,
		threshold: SIGNAL_STORM_THRESHOLD,
		window_started_at: windowStartedAt,
		muted_at: mutedAt,
		expires_at: new Date(now.getTime() + SIGNAL_STORM_MUTE_MS).toISOString(),
		previous_tier: "feed",
		muted_by: "system:bus",
	};
	return {
		schema_version: 1,
		id: uuidv5(`signal-storm:${owner}:${pattern}:${String(bucket)}`),
		type: "subscription.changed",
		ts: mutedAt,
		source: { service: "console-api", host: null, agent: null },
		subject: row.subject,
		subject_kind: "other",
		severity: "warn",
		scope: row.scope,
		dimensions: { action: "storm_muted", pattern, owner, tier: "digest" },
		measures: { event_count: count, window_seconds: SIGNAL_STORM_WINDOW_MS / 1_000 },
		meta: {
			retention_class: "audit",
			entity: {
				...row.state,
				schema_version: 1,
				pattern,
				owner,
				tier: "digest",
				updated_by: "system:bus",
				updated_at: mutedAt,
				storm,
			},
		},
	};
}

function expiredStormEmission(row: SubscriptionRow, now: Date): Emission {
	const pattern = String(row.state["pattern"]);
	const owner = String(row.state["owner"]);
	const storm = row.state["storm"] as Record<string, unknown>;
	const expiredAt = now.toISOString();
	return {
		schema_version: 1,
		id: uuidv5(`signal-storm-expired:${owner}:${pattern}:${String(storm["expires_at"])}`),
		type: "subscription.changed",
		ts: expiredAt,
		source: { service: "console-api", host: null, agent: null },
		subject: row.subject,
		subject_kind: "other",
		severity: "info",
		scope: row.scope,
		dimensions: { action: "storm_expired", pattern, owner, tier: "feed" },
		meta: {
			retention_class: "audit",
			entity: {
				...row.state,
				tier: "feed",
				updated_by: "system:bus",
				updated_at: expiredAt,
				storm: { ...storm, active: false, undone_at: expiredAt, undone_by: "system:bus" },
			},
		},
	};
}

/**
 * Authoritative detector over lake receipt time. It runs after a unique append and changes the same
 * projected subscription entity used by humans and agents, so there is no UI-only mute.
 */
export class SignalStormDetector {
	readonly #sql: Sql;
	readonly #emit: InternalEmit;
	readonly #now: () => Date;
	readonly #resolveOwnerScopes: ResolveOwnerScopes;
	#scan: Promise<void> | null = null;
	#rescan = false;

	constructor(
		sql: Sql,
		emit: InternalEmit,
		now: () => Date = () => new Date(),
		resolveOwnerScopes: ResolveOwnerScopes = async () => [],
	) {
		this.#sql = sql;
		this.#emit = emit;
		this.#now = now;
		this.#resolveOwnerScopes = resolveOwnerScopes;
	}

	async reconcileExpired(): Promise<void> {
		const now = this.#now();
		const sql = this.#sql;
		const expired = await sql<SubscriptionRow[]>`
			select subject, scope, state from current_state
			where kind = 'subscription'
			  and coalesce((state->'storm'->>'active')::boolean, false) = true
			  and (state->'storm'->>'expires_at')::timestamptz <= ${now.toISOString()}::timestamptz`;
		for await (const row of expired) await this.#emit(expiredStormEmission(row, now));
	}

	async observe(emission: Emission): Promise<void> {
		if (
			emission.type.startsWith("audit.") ||
			emission.type.startsWith("subscription.") ||
			emission.type.startsWith("signal.storm.")
		)
			return;
		if (this.#scan) {
			this.#rescan = true;
			return;
		}
		this.#scan = this.#scanUntilCaughtUp();
		try {
			await this.#scan;
		} finally {
			this.#scan = null;
		}
	}

	async #scanUntilCaughtUp(): Promise<void> {
		for await (const iteration of doWhileCondition(() => this.#rescan)) {
			void iteration;
			this.#rescan = false;
			await this.#detect();
		}
	}

	async #detect(): Promise<void> {
		await this.reconcileExpired();
		const sql = this.#sql;
		const subscriptions = await sql<SubscriptionRow[]>`
			select subject, scope, state from current_state
			where kind = 'subscription' and state->>'tier' = 'feed'
			  and coalesce((state->'storm'->>'active')::boolean, false) = false`;
		if (subscriptions.length === 0) return;
		const now = this.#now();
		const since = new Date(now.getTime() - SIGNAL_STORM_WINDOW_MS).toISOString();
		const counts = await sql<EventCountRow[]>`
			select type, scope, severity, source_service, subject, count(*)::text as n
			from events where received_at >= ${since}
			group by type, scope, severity, source_service, subject`;
		for await (const subscription of subscriptions) {
			const pattern = subscription.state["pattern"];
			const owner = subscription.state["owner"];
			if (typeof pattern !== "string" || typeof owner !== "string") continue;
			const readableScopes = await this.#resolveOwnerScopes(owner);
			const count = stormCount(pattern, subscription.state, counts, readableScopes);
			if (count <= SIGNAL_STORM_THRESHOLD) continue;
			await this.#emit(stormSubscriptionEmission(subscription, count, now));
		}
	}
}
