import { describe, expect, it, vi } from "vitest";

import { CrackAttentionReconciler } from "../../src/lib/server/domain/attention/cracks.ts";
import type { Sql } from "../../src/lib/server/domain/db/pool.ts";
import type { Emission } from "../../src/lib/server/domain/emission.ts";

function signal(type: string, subject: string, overrides: Partial<Emission> = {}): Emission {
	return {
		schema_version: 1,
		id: crypto.randomUUID(),
		type,
		ts: "2026-07-13T14:02:00Z",
		source: { service: "fixture", host: null, agent: null },
		subject,
		severity: "danger",
		scope: "fleet",
		...overrides,
	};
}

describe("facade crack attention reconciliation", () => {
	it("recognizes all four approved P0 crack triggers", () => {
		expect(
			["agent.crashed", "service.down", "host.oom", "doorman.dark"].map(
				(type) => CrackAttentionReconciler.transition(signal(type, "subject"))?.rule.kind,
			),
		).toEqual(["agent-crashed", "service-down", "box-ooming", "doorman-dark"]);
	});

	it("recognizes a recovery fact for every trigger", () => {
		expect(
			["agent.heartbeat", "service.up", "host.oom.cleared", "doorman.recover"].map(
				(type) => CrackAttentionReconciler.transition(signal(type, "subject"))?.state,
			),
		).toEqual(["resolved", "resolved", "resolved", "resolved"]);
	});

	it("pre-binds a safe lead recovery operation for every crack family", () => {
		expect(
			["agent.crashed", "service.down", "host.oom", "doorman.dark"].map((type) => {
				const event = signal(type, type === "service.down" ? ".14/api" : ".14", {
					source: { service: "fixture", host: ".14", agent: null },
				});
				return CrackAttentionReconciler.transition(event)?.rule.fixOps(event)[0]?.op;
			}),
		).toEqual(["agent.restart", "service.restart", "host.probe", "doorman.redial"]);
	});

	it("mints one P0 attention entity with server-bound fixes and heals it on recovery", async () => {
		let active = false;
		const sql = (async (strings: TemplateStringsArray) => {
			if (strings.join("?").includes("select exists")) return [{ active }];
			return [];
		}) as unknown as Sql;
		const emitted: Emission[] = [];
		const emit = vi.fn(async (emission: Emission) => {
			emitted.push(emission);
			active = emission.type === "attention.created";
			return { ok: true, seq: emitted.length };
		});
		const reconciler = new CrackAttentionReconciler(sql, emit);
		const down = signal("service.down", ".14/console-api", {
			source: { service: "probe-runner", host: ".14", agent: null },
		});

		await reconciler.enqueue(down);
		await reconciler.enqueue(down);
		const incidentId = CrackAttentionReconciler.transition(down)!.id;
		expect(emitted).toHaveLength(1);
		expect(emitted[0]).toMatchObject({
			type: "attention.created",
			severity: "p0",
			subject: incidentId,
			action: "/hosts",
			meta: {
				entity: {
					grade: "p0",
					summary: "console-api is down on .14.",
					fix_ops: [{ op: "service.restart", args: { host: ".14", service: "console-api" } }],
				},
			},
		});

		await reconciler.enqueue(signal("service.up", ".14/console-api"));
		expect(emitted[1]).toMatchObject({
			type: "attention.resolved",
			subject: incidentId,
			meta: { entity: { resolved_by: "system:crack-detector", resolved_via: "auto" } },
		});
	});

	it("reconstructs an unresolved crack from persisted source facts after restart", async () => {
		const persisted = signal("host.oom", ".14", {
			source: { service: "bridge", host: ".14", agent: null },
		});
		const sql = Object.assign(
			async (strings: TemplateStringsArray) =>
				strings.join("?").includes("from events")
					? [
							{
								...persisted,
								source_service: persisted.source.service,
								source_host: persisted.source.host ?? null,
								source_agent: persisted.source.agent ?? null,
							},
						]
					: [{ active: false }],
			{ array: (values: readonly string[]) => values },
		) as unknown as Sql;
		const emitted: Emission[] = [];
		const reconciler = new CrackAttentionReconciler(sql, async (emission) => {
			emitted.push(emission);
			return { ok: true };
		});

		await reconciler.reconcilePersisted();

		expect(emitted[0]).toMatchObject({
			type: "attention.created",
			subject: CrackAttentionReconciler.transition(persisted)!.id,
			severity: "p0",
			meta: { entity: { summary: ".14 is thrashing after an out-of-memory event." } },
		});
	});

	it("serializes rapid open/recovery facts without waiting for projector state", async () => {
		const sql = (async () => [{ active: false }]) as unknown as Sql;
		const emitted: Emission[] = [];
		const reconciler = new CrackAttentionReconciler(sql, async (emission) => {
			emitted.push(emission);
			return { ok: true };
		});
		await reconciler.enqueue(signal("service.down", ".14/api"));
		await reconciler.enqueue(signal("service.up", ".14/api"));
		expect(emitted.map((event) => event.type)).toEqual(["attention.created", "attention.resolved"]);
	});

	it("uses distinct incident identities for equal subjects in different scopes", () => {
		const fleet = signal("service.down", ".14/api");
		const project = signal("service.down", ".14/api", { scope: "project:console" });
		expect(CrackAttentionReconciler.transition(fleet)?.id).not.toBe(
			CrackAttentionReconciler.transition(project)?.id,
		);
	});
});
