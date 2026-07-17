import { randomUUID } from "node:crypto";

import { asynchronously } from "#domain/iteration";

import { uuidv5 } from "../bridge/uuid5.ts";
import type { Sql } from "../db/pool.ts";
import type { Emission } from "../emission.ts";

type EmitInternal = (emission: Emission) => Promise<{ ok: boolean; code?: string; seq?: number }>;

type FixOp = { readonly op: string; readonly args: Record<string, unknown> };

interface CrackRule {
	readonly kind: "agent-crashed" | "service-down" | "box-ooming" | "doorman-dark";
	readonly opens: readonly string[];
	readonly closes: readonly string[];
	readonly action: string;
	summary(emission: Emission): string;
	fixOps(emission: Emission): readonly FixOp[];
}

function textDimension(emission: Emission, key: string): string | null {
	const value = emission.dimensions?.[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function serviceParts(emission: Emission): { host: string | null; service: string | null } {
	const slash = emission.subject.indexOf("/");
	return {
		host:
			emission.source.host ??
			textDimension(emission, "host") ??
			(slash > 0 ? emission.subject.slice(0, slash) : null),
		service:
			textDimension(emission, "service") ??
			(slash > 0 ? emission.subject.slice(slash + 1) : emission.subject || null),
	};
}

const RULES: readonly CrackRule[] = [
	{
		kind: "agent-crashed",
		opens: ["agent.crashed"],
		closes: ["agent.heartbeat"],
		action: "/agents",
		summary: (emission) => `Agent ${emission.subject} crashed.`,
		fixOps: (emission) => [{ op: "agent.restart", args: { handle: emission.subject } }],
	},
	{
		kind: "service-down",
		opens: ["service.down"],
		closes: ["service.up"],
		action: "/hosts",
		summary: (emission) => {
			const { host, service } = serviceParts(emission);
			return host && service ? `${service} is down on ${host}.` : `${emission.subject} is down.`;
		},
		fixOps: (emission) => {
			const { host, service } = serviceParts(emission);
			return host && service ? [{ op: "service.restart", args: { host, service } }] : [];
		},
	},
	{
		kind: "box-ooming",
		opens: ["host.oom", "box.oom"],
		closes: ["host.oom.cleared", "box.oom.cleared"],
		action: "/hosts",
		summary: (emission) => {
			const host = emission.source.host ?? textDimension(emission, "host") ?? emission.subject;
			return `${host} is thrashing after an out-of-memory event.`;
		},
		fixOps: (emission) => [
			{
				op: "host.probe",
				args: {
					target: emission.source.host ?? textDimension(emission, "host") ?? emission.subject,
				},
			},
		],
	},
	{
		kind: "doorman-dark",
		opens: ["doorman.dark"],
		closes: ["doorman.recover"],
		action: "/network",
		summary: (emission) => `Doorman ${emission.subject} is dark. The edge is unreachable.`,
		fixOps: (emission) => [{ op: "doorman.redial", args: { handle: emission.subject } }],
	},
];

const CRACK_SIGNAL_TYPES = RULES.flatMap((rule) => [...rule.opens, ...rule.closes]);

interface PersistedSignalRow {
	readonly id: string;
	readonly type: string;
	readonly ts: string;
	readonly source_service: string;
	readonly source_host: string | null;
	readonly source_agent: string | null;
	readonly subject: string;
	readonly subject_kind: Emission["subject_kind"];
	readonly severity: Emission["severity"];
	readonly action: string | null;
	readonly task_id: number | null;
	readonly scope: string;
	readonly dimensions: Emission["dimensions"];
	readonly measures: Emission["measures"];
	readonly meta: Emission["meta"];
}

interface CrackTransition {
	readonly state: "open" | "resolved";
	readonly rule: CrackRule;
	readonly id: string;
}

function crackIncidentId(rule: CrackRule, emission: Emission): string {
	return `crack:${rule.kind}:${uuidv5(`${emission.scope}:${emission.subject}`)}`;
}

/** Pure trigger matcher kept shared by tests and the live reconciliation path. */
function crackTransition(emission: Emission): CrackTransition | null {
	for (const rule of RULES) {
		const state = rule.opens.includes(emission.type)
			? "open"
			: rule.closes.includes(emission.type)
				? "resolved"
				: null;
		if (state) return { state, rule, id: crackIncidentId(rule, emission) };
	}
	return null;
}

/**
 * Turns authenticated infrastructure facts into the one P0 attention entity consumed by the
 * Cockpit. Source producers only report their own state; this reconciler owns facade policy,
 * incident identity, pre-bound recovery operations, and automatic healing on recovery facts.
 */
export class CrackAttentionReconciler {
	readonly #sql: Sql;
	readonly #emit: EmitInternal;
	readonly #activeByIncident = new Map<string, boolean>();
	#tail: Promise<void> = Promise.resolve();

	constructor(sql: Sql, emit: EmitInternal) {
		this.#sql = sql;
		this.#emit = emit;
	}

	/** Classifies a source fact using the same policy as live reconciliation. */
	static transition(emission: Emission): CrackTransition | null {
		return crackTransition(emission);
	}

	enqueue(emission: Emission): Promise<void> {
		const run = this.#tail.then(() => this.#observe(emission));
		this.#tail = run.catch(() => undefined);
		return run;
	}

	drain(): Promise<void> {
		return this.#tail;
	}

	/** Rebuild crack truth after a console-api restart from the latest fact in each incident family. */
	async reconcilePersisted(): Promise<void> {
		const rows = await this.#sql<PersistedSignalRow[]>`
			select distinct on (
				scope,
				subject,
				case
					when type in ('agent.crashed', 'agent.heartbeat') then 'agent-crashed'
					when type in ('service.down', 'service.up') then 'service-down'
					when type in ('host.oom', 'box.oom', 'host.oom.cleared', 'box.oom.cleared') then 'box-ooming'
					when type in ('doorman.dark', 'doorman.recover') then 'doorman-dark'
				end
			)
			id::text, type, ts::text, source_service, source_host, source_agent, subject,
			subject_kind, severity, action, task_id, scope, dimensions, measures, meta
			from events where type = any(${this.#sql.array(CRACK_SIGNAL_TYPES)})
			order by scope, subject,
				case
					when type in ('agent.crashed', 'agent.heartbeat') then 'agent-crashed'
					when type in ('service.down', 'service.up') then 'service-down'
					when type in ('host.oom', 'box.oom', 'host.oom.cleared', 'box.oom.cleared') then 'box-ooming'
					when type in ('doorman.dark', 'doorman.recover') then 'doorman-dark'
				end,
				seq desc`;
		for await (const row of asynchronously(rows))
			await this.enqueue({
				schema_version: 1,
				id: row.id,
				type: row.type,
				ts: row.ts,
				source: {
					service: row.source_service,
					host: row.source_host,
					agent: row.source_agent,
				},
				subject: row.subject,
				subject_kind: row.subject_kind,
				severity: row.severity,
				action: row.action,
				task_id: row.task_id,
				scope: row.scope,
				dimensions: row.dimensions,
				measures: row.measures,
				meta: row.meta,
			});
	}

	async #active(id: string, scope: string): Promise<boolean> {
		const cached = this.#activeByIncident.get(id);
		if (cached !== undefined) return cached;
		const rows = await this.#sql<{ active: boolean }[]>`
			select exists(select 1 from current_state where kind = 'attention' and subject = ${id}
			  and scope = ${scope} and state->>'resolved_at' is null) as active`;
		const active = rows[0].active;
		this.#activeByIncident.set(id, active);
		return active;
	}

	async #emitRequired(emission: Emission): Promise<void> {
		const result = await this.#emit(emission);
		if (!result.ok) throw new Error(`crack attention emission failed: ${result.code ?? "unknown"}`);
	}

	async #observe(emission: Emission): Promise<void> {
		if (emission.subject.startsWith("crack:")) {
			if (emission.type === "attention.created") this.#activeByIncident.set(emission.subject, true);
			if (emission.type === "attention.resolved")
				this.#activeByIncident.set(emission.subject, false);
		}
		const transition = CrackAttentionReconciler.transition(emission);
		if (!transition) return;
		const active = await this.#active(transition.id, emission.scope);
		if (transition.state === "open" && active) return;
		if (transition.state === "resolved" && !active) return;

		const now = new Date().toISOString();
		if (transition.state === "resolved") {
			await this.#emitRequired({
				schema_version: 1,
				id: randomUUID(),
				type: "attention.resolved",
				ts: now,
				source: { service: "console-api", host: null, agent: null },
				subject: transition.id,
				subject_kind: "other",
				severity: "info",
				scope: emission.scope,
				dimensions: { resolved_via: "auto", trigger: emission.type },
				meta: {
					retention_class: "audit",
					entity: { resolved_at: now, resolved_by: "system:crack-detector", resolved_via: "auto" },
				},
			});
			this.#activeByIncident.set(transition.id, false);
			return;
		}

		const blastHost = emission.source.host ?? textDimension(emission, "host");
		await this.#emitRequired({
			schema_version: 1,
			id: randomUUID(),
			type: "attention.created",
			ts: now,
			source: { service: "console-api", host: null, agent: null },
			subject: transition.id,
			subject_kind: "other",
			severity: "p0",
			action: transition.rule.action,
			scope: emission.scope,
			dimensions: { incident_key: transition.id, trigger: emission.type },
			meta: {
				retention_class: "audit",
				entity: {
					schema_version: 1,
					id: transition.id,
					grade: "p0",
					source: `bus:${emission.type}`,
					subject: emission.subject,
					summary: transition.rule.summary(emission),
					ts: emission.ts,
					scope: emission.scope,
					task_id: emission.task_id ?? null,
					incident_key: transition.id,
					fix_ops: transition.rule.fixOps(emission),
					...(blastHost ? { blast_radius: { hosts: 1, detail: `On ${blastHost}` } } : {}),
					resolved_at: null,
				},
			},
		});
		this.#activeByIncident.set(transition.id, true);
	}
}
