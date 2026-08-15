import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	ActorAuthority,
	ActorAuthorityLayer,
	type PersonPrincipal,
} from "../src/lib/server/actors/authority";
import { InvocationContext } from "../src/lib/server/invocation";
import { LoopCommands, LoopCommandsLayer } from "../src/lib/server/loop/service";
import { startGrovePostgres, stopGrovePostgres } from "./postgres";

const ownerIdentity = { issuer: "https://identity.example/grove", subject: "owner" };
const invoke = <A, E, R>(
	principal: PersonPrincipal,
	effect: Effect.Effect<A, E, R | InvocationContext>,
) =>
	effect.pipe(
		Effect.provideService(InvocationContext, {
			principal,
			transport: "rest",
			requestId: crypto.randomUUID(),
		}),
	);

describe("Grove agent loop", () => {
	let runtime: ManagedRuntime.ManagedRuntime<
		ActorAuthority | LoopCommands | PgClient.PgClient,
		unknown
	>;
	let owner: PersonPrincipal;
	let reviewer: PersonPrincipal;

	beforeAll(async () => {
		const postgres = await startGrovePostgres();
		const authority = ActorAuthorityLayer({ homeOwner: ownerIdentity }).pipe(
			Layer.provideMerge(PgClient.layer({ url: Redacted.make(postgres.databaseUrl) })),
		);
		runtime = ManagedRuntime.make(LoopCommandsLayer.pipe(Layer.provideMerge(authority)));
		owner = await runtime.runPromise(
			Effect.flatMap(ActorAuthority, (a) =>
				a.bindBrowserIdentity({
					...ownerIdentity,
					authUserId: "owner-auth",
					name: "Owner",
					emailVerified: true,
				}),
			),
		);
		reviewer = await runtime.runPromise(
			Effect.flatMap(ActorAuthority, (a) =>
				a.bindBrowserIdentity({
					issuer: ownerIdentity.issuer,
					subject: "reviewer",
					authUserId: "reviewer-auth",
					name: "Reviewer",
					emailVerified: true,
				}),
			),
		);
	}, 60_000);

	afterAll(async () => {
		await runtime.dispose();
		await stopGrovePostgres();
	});
	const run = <A, E>(
		principal: PersonPrincipal,
		use: (commands: LoopCommands["Service"]) => Effect.Effect<A, E, InvocationContext>,
	) => runtime.runPromise(invoke(principal, Effect.flatMap(LoopCommands, use)));

	it("runs project command -> task execution -> independent reviewed completion -> library retrieval", async () => {
		const project = await run(owner, (c) =>
			c.createProject({ title: "Demo", ask: "Produce the agent-loop proof" }),
		);
		const plan = await run(owner, (c) =>
			c.planProject({
				projectId: String(project.projectId),
				expectedVersionId: String(project.versionId),
				title: "Write proof",
				objective: "Explain reviewed completion",
			}),
		);
		const ready = await run(owner, (c) => c.readyWork({ projectId: String(project.projectId) }));
		expect(ready).toHaveLength(1);
		const claim = await run(owner, (c) => c.claimTask({ taskId: String(plan.taskId) }));
		const artifact = await run(owner, (c) =>
			c.publishAttempt({
				attemptId: String(claim.attemptId),
				fence: String(claim.fence),
				title: "Reviewed proof",
				content: "The independent reviewer accepted this artifact.",
			}),
		);
		const review = await run(reviewer, (c) =>
			c.submitReview({
				attemptId: String(claim.attemptId),
				outcome: "accepted",
				comments: "Looks good",
			}),
		);
		expect(review.outcome).toBe("accepted");
		const completed = await run(owner, (c) =>
			c.completeTask({ taskId: String(plan.taskId), expectedVersionId: String(plan.versionId) }),
		);
		expect(completed.artifactId).toBe(artifact.artifactId);
		const library = await run(reviewer, (c) =>
			c.searchLibrary({ projectId: String(project.projectId), query: "independent reviewer" }),
		);
		expect(library).toEqual([
			expect.objectContaining({ artifactId: artifact.artifactId, reviewId: completed.reviewId }),
		]);
	});
});
