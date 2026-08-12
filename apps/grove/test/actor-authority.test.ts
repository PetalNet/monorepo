import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	ActorAuthority,
	ActorAuthorityLayer,
	CapabilityContainmentConflict,
	HomeOwnerUnbound,
	type AgentPrincipal,
	type MachineIdentity,
} from "../src/lib/server/actors/authority";
import { InvocationContext } from "../src/lib/server/invocation";
import { SproutCommands, SproutCommandsLayer } from "../src/lib/server/sprouts/service";
import { startGrovePostgres, stopGrovePostgres } from "./postgres";

const ownerIdentity = {
	issuer: "https://identity.example/realms/grove",
	subject: "operator-1",
};
const machine = (issuer: string, subject: string, enrollment = true): MachineIdentity => ({
	issuer,
	subject,
	scopes: new Set(["grove:mcp", ...(enrollment ? ["grove:agent:enroll"] : [])]),
});
const authority = <A, E>(use: (service: ActorAuthority["Service"]) => Effect.Effect<A, E>) =>
	Effect.flatMap(ActorAuthority, use);
const actorInvocation = <A, E, R>(principal: AgentPrincipal, effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.provideService(InvocationContext, {
			principal,
			transport: "mcp",
			requestId: crypto.randomUUID(),
		}),
	);

describe("actor authority", () => {
	let runtime: ManagedRuntime.ManagedRuntime<ActorAuthority | SproutCommands, unknown>;
	let databaseRuntime: ManagedRuntime.ManagedRuntime<PgClient.PgClient, unknown>;
	let databaseUrl: string;

	beforeAll(async () => {
		const postgres = await startGrovePostgres();
		databaseUrl = postgres.databaseUrl;
		databaseRuntime = postgres.runtime;
		const actors = ActorAuthorityLayer({
			homeOwner: ownerIdentity,
		}).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(postgres.databaseUrl) })));
		runtime = ManagedRuntime.make(SproutCommandsLayer.pipe(Layer.provideMerge(actors)));
	}, 60_000);

	afterAll(async () => {
		await runtime.dispose();
		await stopGrovePostgres();
	});

	const run = <A, E>(effect: Effect.Effect<A, E, ActorAuthority | SproutCommands>) =>
		runtime.runPromise(effect);
	const waitForBlockedSproutWrite = async (attempt = 0): Promise<undefined> => {
		const waiting = await databaseRuntime.runPromise(
			Effect.flatMap(PgClient.PgClient, (sql) =>
				sql.unsafe<{ waiting: number }>(
					`select count(*)::int as waiting
               from pg_stat_activity
              where wait_event_type = 'Lock'
                and query like '%grove_demo_sprouts%'
                and query not like '%pg_stat_activity%'`,
				),
			),
		);
		if ((waiting.at(0)?.waiting ?? 0) > 0) return undefined;
		if (attempt >= 99) throw new Error("Sprout write did not block on the table lock");
		await new Promise((resolve) => setTimeout(resolve, 10));
		return waitForBlockedSproutWrite(attempt + 1);
	};

	it("JIT-binds verified browser identities and only the configured identity claims Home Host", async () => {
		const other = await run(
			authority((actors) =>
				actors.bindBrowserIdentity({
					authUserId: "auth-other",
					issuer: ownerIdentity.issuer,
					subject: "someone-else",
					name: "Someone Else",
					emailVerified: true,
				}),
			),
		);
		expect(other.kind).toBe("person");
		expect(await run(authority((actors) => actors.homeReadiness))).toMatchObject({
			status: "owner-unbound",
			configuredIdentity: ownerIdentity,
		});

		const owner = await run(
			authority((actors) =>
				actors.bindBrowserIdentity({
					authUserId: "auth-owner",
					...ownerIdentity,
					name: "Grove Operator",
					emailVerified: true,
				}),
			),
		);
		const repeated = await run(
			authority((actors) =>
				actors.bindBrowserIdentity({
					authUserId: "auth-owner",
					...ownerIdentity,
					name: "Mutable display name",
					emailVerified: true,
				}),
			),
		);

		expect(repeated.actorId).toBe(owner.actorId);
		expect(await run(authority((actors) => actors.homeReadiness))).toEqual({
			status: "ready",
			ownerPersonId: owner.actorId,
		});
	});

	it("explicitly enrolls issuer-qualified machine identities and is idempotent", async () => {
		const identity = machine("https://machine.example/issuer-a", "janet");
		const bootstrap = await run(authority((actors) => actors.resolveMachineIdentity(identity)));
		expect(bootstrap.kind).toBe("bootstrap");

		const janet = await run(authority((actors) => actors.enrollSelf(bootstrap, { name: "Janet" })));
		const repeated = await run(
			authority((actors) => actors.enrollSelf(identity, { name: "A name ignored on retry" })),
		);
		expect(repeated).toEqual(janet);
		expect(janet).toMatchObject({ kind: "agent", name: "Janet", homeHostId: "host-local" });

		const sameSubjectOtherIssuer = machine("https://machine.example/issuer-b", "janet");
		const other = await run(
			authority((actors) => actors.enrollSelf(sameSubjectOtherIssuer, { name: "Other Janet" })),
		);
		expect(other.actorId).not.toBe(janet.actorId);
	});

	it("serializes concurrent enrollment retries for the same external identity", async () => {
		const identity = machine("https://machine.example/issuer-a", "concurrent-agent");
		const [first, second] = await Promise.all([
			run(authority((actors) => actors.enrollSelf(identity, { name: "Concurrent Agent" }))),
			run(authority((actors) => actors.enrollSelf(identity, { name: "Concurrent Agent" }))),
		]);

		expect(second.actorId).toBe(first.actorId);
	});

	it("keeps unbound identities restricted and blocks enrollment before owner binding", async () => {
		const postgres = await startGrovePostgres();
		const isolated = ManagedRuntime.make(
			ActorAuthorityLayer({
				homeOwner: { issuer: ownerIdentity.issuer, subject: "not-bound-in-this-database" },
			}).pipe(Layer.provide(PgClient.layer({ url: Redacted.make(postgres.databaseUrl) }))),
		);
		try {
			const withoutScope = await isolated.runPromise(
				Effect.flatMap(ActorAuthority, (actors) =>
					actors.resolveMachineIdentity(machine("https://machine.example", "no-scope", false)),
				),
			);
			expect(withoutScope.kind).toBe("unbound");

			const error = await isolated.runPromise(
				Effect.flatMap(ActorAuthority, (actors) =>
					actors.enrollSelf(machine("https://machine.example", "blocked"), { name: "Blocked" }),
				).pipe(Effect.flip),
			);
			expect(error).toBeInstanceOf(HomeOwnerUnbound);
		} finally {
			await isolated.dispose();
		}
	}, 60_000);

	it("rejects capability containment violations with explicit fixes and revokes currentness", async () => {
		const actors = await run(
			authority((service) =>
				Effect.all({
					owner: service.bindBrowserIdentity({
						authUserId: "auth-owner",
						...ownerIdentity,
						name: "Grove Operator",
						emailVerified: true,
					}),
					guest: service.bindBrowserIdentity({
						authUserId: "auth-guest",
						issuer: ownerIdentity.issuer,
						subject: "guest",
						name: "Guest",
						emailVerified: true,
					}),
				}),
			),
		);
		const agent = await run(
			authority((service) =>
				service.enrollSelf(machine("https://machine.example", "containment"), {
					name: "Containment Agent",
				}),
			),
		);
		await run(
			authority((service) =>
				service.grantAgentAccessAs(actors.owner, agent.actorId, actors.guest.actorId),
			),
		);
		const compatibilityPolicy = await run(
			authority((service) =>
				service
					.removePersonCapabilityAs(actors.guest, actors.guest.actorId, "sprouts.water")
					.pipe(Effect.flip),
			),
		);
		expect(compatibilityPolicy).toMatchObject({ _tag: "ActorDenied" });
		await Promise.all(
			[actors.owner, actors.guest].map((person) =>
				run(
					authority((service) =>
						service.applyContainmentFixAs(actors.owner, {
							action: "grant-person-capability",
							agentId: agent.actorId,
							personId: person.actorId,
							capability: "agents.observe",
						}),
					),
				),
			),
		);
		await run(
			authority((service) =>
				service.requestAgentCapability(actors.owner, agent.actorId, "agents.observe"),
			),
		);

		const reducing = await run(
			authority((service) =>
				service
					.removePersonCapabilityAs(actors.guest, actors.guest.actorId, "agents.observe")
					.pipe(Effect.flip),
			),
		);
		if (!(reducing instanceof CapabilityContainmentConflict)) throw reducing;
		expect(reducing.conflicts).toMatchObject([
			{ agentId: agent.actorId, personId: actors.guest.actorId },
		]);
		const reducingActions = reducing.fixes.map((fix) => fix.action);
		expect(reducingActions).toContain("grant-person-capability");
		expect(reducingActions).toContain("remove-agent-access");
		expect(reducingActions).toContain("remove-agent-capability");

		const expanding = await run(
			authority((service) =>
				service
					.requestAgentCapability(actors.owner, agent.actorId, "agents.delegate")
					.pipe(Effect.flip),
			),
		);
		if (!(expanding instanceof CapabilityContainmentConflict)) throw expanding;
		const conflictPersonIds = expanding.conflicts.map((conflict) => conflict.personId);
		expect(conflictPersonIds).toContain(actors.owner.actorId);
		expect(conflictPersonIds).toContain(actors.guest.actorId);

		await run(authority((service) => service.suspendActor(agent.actorId)));
		const stale = await run(
			authority((service) => service.authorizeActor(agent, "sprouts.list").pipe(Effect.flip)),
		);
		expect(stale).toMatchObject({ _tag: "ActorNotCurrent", actorId: agent.actorId });
		const enrollmentRetry = await run(
			authority((service) =>
				service.enrollSelf(agent, { name: "Cannot reactivate" }).pipe(Effect.flip),
			),
		);
		expect(enrollmentRetry).toMatchObject({
			_tag: "ActorNotCurrent",
			actorId: agent.actorId,
		});
	});

	it("serializes an authorized write before concurrent suspension completes", async () => {
		const agent = await run(
			authority((service) =>
				service.enrollSelf(machine("https://machine.example", "linearizable-revocation"), {
					name: "Linearizable Agent",
				}),
			),
		);
		const acquired = Promise.withResolvers<undefined>();
		const release = Promise.withResolvers<undefined>();
		const blocker = databaseRuntime.runPromise(
			Effect.flatMap(PgClient.PgClient, (sql) =>
				sql.withTransaction(
					sql.unsafe("lock table grove_demo_sprouts in access exclusive mode").pipe(
						Effect.tap(() =>
							Effect.sync(() => {
								acquired.resolve(undefined);
							}),
						),
						Effect.andThen(Effect.promise(() => release.promise)),
					),
				),
			),
		);
		await acquired.promise;

		const completionOrder: string[] = [];
		const write = run(
			actorInvocation(
				agent,
				Effect.flatMap(SproutCommands, (commands) =>
					commands.create({ name: "Write before suspension" }),
				),
			),
		).then((created) => {
			completionOrder.push("write");
			return created;
		});
		await waitForBlockedSproutWrite();

		const suspension = run(authority((service) => service.suspendActor(agent.actorId))).then(() => {
			completionOrder.push("suspension");
			return undefined;
		});
		try {
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(completionOrder).toEqual([]);
		} finally {
			release.resolve(undefined);
			await blocker;
		}
		const [created] = await Promise.all([write, suspension]);

		expect(created.name).toBe("Write before suspension");
		expect(completionOrder).toEqual(["write", "suspension"]);
	});

	it("keeps retirement terminal", async () => {
		const agent = await run(
			authority((service) =>
				service.enrollSelf(machine("https://machine.example", "retired-agent"), {
					name: "Retired Agent",
				}),
			),
		);
		await run(authority((service) => service.retireActor(agent.actorId)));

		const transition = await run(
			authority((service) => service.suspendActor(agent.actorId).pipe(Effect.flip)),
		);

		expect(transition).toMatchObject({
			_tag: "ActorDenied",
			reason: "A retired Actor cannot change lifecycle",
		});
	});

	it("reports owner configuration drift and a non-current bound owner", async () => {
		const changedOwner = {
			issuer: ownerIdentity.issuer,
			subject: "replacement-owner",
		};
		const drifted = ManagedRuntime.make(
			ActorAuthorityLayer({ homeOwner: changedOwner }).pipe(
				Layer.provide(PgClient.layer({ url: Redacted.make(databaseUrl) })),
			),
		);
		try {
			expect(
				await drifted.runPromise(
					Effect.flatMap(ActorAuthority, (service) => service.homeReadiness),
				),
			).toMatchObject({
				status: "owner-config-mismatch",
				configuredIdentity: changedOwner,
			});
		} finally {
			await drifted.dispose();
		}

		const owner = await run(
			authority((service) =>
				service.bindBrowserIdentity({
					authUserId: "auth-owner",
					...ownerIdentity,
					name: "Grove Operator",
					emailVerified: true,
				}),
			),
		);
		await run(authority((service) => service.suspendActor(owner.actorId)));

		expect(await run(authority((service) => service.homeReadiness))).toMatchObject({
			status: "owner-not-current",
			ownerPersonId: owner.actorId,
			lifecycle: "suspended",
		});
	});
});
