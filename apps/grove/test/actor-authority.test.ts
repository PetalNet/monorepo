import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	ActorAuthority,
	ActorAuthorityLayer,
	CapabilityContainmentConflict,
	HomeOwnerUnbound,
	type MachineIdentity,
} from "../src/lib/server/actors/authority";
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

describe("actor authority", () => {
	let runtime: ManagedRuntime.ManagedRuntime<ActorAuthority, unknown>;

	beforeAll(async () => {
		const postgres = await startGrovePostgres();
		runtime = ManagedRuntime.make(
			ActorAuthorityLayer({
				homeOwner: ownerIdentity,
			}).pipe(Layer.provide(PgClient.layer({ url: Redacted.make(postgres.databaseUrl) }))),
		);
	}, 60_000);

	afterAll(async () => {
		await runtime.dispose();
		await stopGrovePostgres();
	});

	const run = <A, E>(effect: Effect.Effect<A, E, ActorAuthority>) => runtime.runPromise(effect);

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
			authority((service) => service.grantAgentAccess(agent.actorId, actors.guest.actorId)),
		);
		const compatibilityPolicy = await run(
			authority((service) =>
				service.removePersonCapability(actors.guest.actorId, "sprouts.water").pipe(Effect.flip),
			),
		);
		expect(compatibilityPolicy).toMatchObject({ _tag: "ActorDenied" });
		await Promise.all(
			[actors.owner, actors.guest].map((person) =>
				run(
					authority((service) =>
						service.applyContainmentFix({
							action: "grant-person-capability",
							agentId: agent.actorId,
							personId: person.actorId,
							capability: "agents.observe",
						}),
					),
				),
			),
		);
		await run(authority((service) => service.addAgentCapability(agent.actorId, "agents.observe")));

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
});
