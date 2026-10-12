import { setTimeout as delay } from "node:timers/promises";

import * as PgClient from "@effect/sql-pg/PgClient";
import type { ApiServer } from "@petalnet/effect-api";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { HttpServerRequest } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	ActorAuthority,
	ActorAuthorityLayer,
	type ActorPrincipal,
	type PersonPrincipal,
} from "../src/lib/server/actors/authority";
import { groveApi } from "../src/lib/server/api";
import { InvocationContext } from "../src/lib/server/invocation";
import { canonicalDigest } from "../src/lib/server/projects/canonical";
import {
	CommandConflict,
	FenceConflict,
	ProjectDatabaseError,
	ProjectService,
	ProjectServiceLayer,
	type ProjectServiceShape,
} from "../src/lib/server/projects/service";
import { startGrovePostgres, stopGrovePostgres } from "./postgres";

const identity = { issuer: "https://identity.example/projects", subject: "owner" };
const input = () => ({
	commandId: crypto.randomUUID(),
	scope: "team/core",
	title: "Ship Grove",
	ask: "Create the object foundation",
});

describe("ProjectService durable actor PostgreSQL integration", () => {
	let runtime: ManagedRuntime.ManagedRuntime<
		ProjectService | ActorAuthority | PgClient.PgClient | ApiServer,
		unknown
	>;
	let database: ManagedRuntime.ManagedRuntime<PgClient.PgClient, unknown>;
	let owner: PersonPrincipal;
	let reviewer: ActorPrincipal;
	let agent: ActorPrincipal;

	beforeAll(async () => {
		const postgres = await startGrovePostgres();

		database = postgres.runtime;

		const actors = ActorAuthorityLayer({ homeOwner: identity }).pipe(
			Layer.provideMerge(PgClient.layer({ url: Redacted.make(postgres.databaseUrl) })),
		);

		runtime = ManagedRuntime.make(
			Layer.mergeAll(ProjectServiceLayer.pipe(Layer.provideMerge(actors)), groveApi.layer),
		);

		owner = await runtime.runPromise(
			Effect.flatMap(ActorAuthority, (a) =>
				a.bindBrowserIdentity({
					authUserId: "project-owner",
					...identity,
					name: "Owner",
					emailVerified: true,
				}),
			),
		);

		reviewer = await runtime.runPromise(
			Effect.flatMap(ActorAuthority, (a) =>
				a.bindBrowserIdentity({
					authUserId: "project-reviewer",
					issuer: identity.issuer,
					subject: "reviewer",
					name: "Reviewer",
					emailVerified: true,
				}),
			),
		);

		agent = await runtime.runPromise(
			Effect.flatMap(ActorAuthority, (a) =>
				a.enrollSelf(
					{
						issuer: "https://machine.example",
						subject: "project-agent",
						scopes: new Set(["grove:mcp", "grove:agent:enroll"]),
					},
					{ name: "Project Agent" },
				),
			),
		);
	}, 60_000);

	afterAll(async () => {
		await runtime.dispose();
		await database.dispose();
		await stopGrovePostgres();
	});

	const call = <A, E>(
		principal: ActorPrincipal,
		invoke: (service: ProjectServiceShape) => Effect.Effect<A, E, InvocationContext>,
	) =>
		runtime.runPromise(
			Effect.flatMap(ProjectService, invoke).pipe(
				Effect.provideService(InvocationContext, { principal }),
			),
		);
	const query = <Row extends object = Record<string, unknown>>(
		text: string,
		values?: readonly unknown[],
	) =>
		database.runPromise(
			Effect.flatMap(PgClient.PgClient, (sql) =>
				values ? sql.unsafe<Row>(text, values) : sql.unsafe<Row>(text),
			),
		);
	const counts = () =>
		query<{ objects: number; versions: number; receipts: number; events: number }>(
			`select (select count(*)::int from grove_objects) objects, (select count(*)::int from grove_object_versions) versions, (select count(*)::int from grove_command_receipts) receipts, (select count(*)::int from grove_outbox) events`,
		);
	const waitForLock = async (deadline = Date.now() + 5000): Promise<undefined> => {
		const [row] = await query<{ waiting: boolean }>(
			"select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query not like '%pg_stat_activity%') waiting",
		);

		if (row.waiting) {
			return undefined;
		}

		if (Date.now() > deadline) {
			throw new Error("Operation never reached PostgreSQL row lock");
		}

		await delay(10);

		return waitForLock(deadline);
	};

	const planProject = async () => {
		const project = await call(owner, (s) => s.create(input()));
		const contract = {
			requiredOutputs: ["artifact"] as ["artifact"],
			reviewRequired: true as const,
		};
		const planInput = {
			commandId: crypto.randomUUID(),
			projectId: project.objectId,
			expectedVersionId: project.versionId,
			tasks: [
				{
					key: "first",
					title: "First",
					objective: "Produce artifact",
					completionContract: contract,
				},
				{
					key: "second",
					title: "Second",
					objective: "Consume artifact",
					completionContract: contract,
				},
			],
			dependencies: [{ task: "second", dependsOn: "first" }],
		};
		const plan = await call(owner, (s) => s.plan(planInput));

		return { project, plan, planInput };
	};

	it("atomically writes canonical heads, replays without duplicates, and rejects different durable actors", async () => {
		const command = input();
		const before = (await counts())[0];
		const first = await call(owner, (s) => s.create(command));
		const after = (await counts())[0];

		expect(after).toEqual({
			objects: before.objects + 1,
			versions: before.versions + 1,
			receipts: before.receipts + 1,
			events: before.events + 1,
		});

		const rows = await query<{
			payload: unknown;
			digest: string;
			actor_id: string;
			actor_kind: string;
		}>("select payload,digest,actor_id,actor_kind from grove_object_versions where id=$1", [
			first.versionId,
		]);

		expect(rows[0].digest).toBe(await Effect.runPromise(canonicalDigest(rows[0].payload)));
		expect(rows[0].actor_id).toBe(owner.actorId);
		expect(rows[0].actor_kind).toBe("person");
		expect(await call(owner, (s) => s.create(command))).toEqual({ ...first, replayed: true });
		await expect(call(reviewer, (s) => s.create(command))).rejects.toBeInstanceOf(CommandConflict);

		await expect(
			call(owner, (s) => s.create({ ...command, title: "changed" })),
		).rejects.toBeInstanceOf(CommandConflict);

		expect(await counts()).toEqual([after]);
		const concurrent = input();
		const responses = await Promise.all([
			call(owner, (s) => s.create(concurrent)),
			call(owner, (s) => s.create(concurrent)),
		]);

		expect(responses[0].objectId).toBe(responses[1].objectId);
		expect(responses.filter((r) => r.replayed)).toHaveLength(1);
	});

	it("rolls back all cardinalities when an outbox write fails late", async () => {
		await query(
			`create function reject_project_outbox() returns trigger language plpgsql as $$ begin raise exception 'injected late failure'; end $$`,
		);

		await query(
			"create trigger reject_project_outbox before insert on grove_outbox for each row execute function reject_project_outbox()",
		);

		const before = await counts();

		try {
			await expect(call(owner, (s) => s.create(input()))).rejects.toBeInstanceOf(
				ProjectDatabaseError,
			);

			expect(await counts()).toEqual(before);
		} finally {
			await query("drop trigger reject_project_outbox on grove_outbox");
			await query("drop function reject_project_outbox()");
		}
	});

	it("rejects DAG cycles and repeat planning without partial writes", async () => {
		const { project, planInput } = await planProject();
		const before = await counts();

		await expect(
			call(owner, (s) => s.plan({ ...planInput, commandId: crypto.randomUUID() })),
		).rejects.toBeInstanceOf(CommandConflict);

		expect(await counts()).toEqual(before);
		const other = await call(owner, (s) => s.create(input()));
		const cycleBefore = await counts();

		await expect(
			call(owner, (s) =>
				s.plan({
					...planInput,
					commandId: crypto.randomUUID(),
					projectId: other.objectId,
					expectedVersionId: other.versionId,
					dependencies: [
						{ task: "first", dependsOn: "second" },
						{ task: "second", dependsOn: "first" },
					],
				}),
			),
		).rejects.toBeInstanceOf(CommandConflict);

		expect(await counts()).toEqual(cycleBefore);
		expect(project.objectId).not.toBe(other.objectId);
	});

	it("claims exclusively, renews/releases, and commits expiry recovery before rejecting a stale fence", async () => {
		const { plan } = await planProject();
		const taskId = plan.taskIds.first;
		const claims = await Promise.allSettled([
			call(owner, (s) => s.claim({ commandId: crypto.randomUUID(), taskId, leaseSeconds: 60 })),
			call(agent, (s) => s.claim({ commandId: crypto.randomUUID(), taskId, leaseSeconds: 60 })),
		]);

		expect(claims.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		const winner = claims[0].status === "fulfilled" ? owner : agent;
		const result = claims.find((r) => r.status === "fulfilled");

		if (!result) {
			throw new Error("No successful claim");
		}

		const claim = result.value;

		await call(winner, (s) =>
			s.renew({
				commandId: crypto.randomUUID(),
				claimId: claim.claimId,
				fence: claim.fence,
				leaseSeconds: 60,
			}),
		);

		await call(winner, (s) =>
			s.release({ commandId: crypto.randomUUID(), claimId: claim.claimId, fence: claim.fence }),
		);

		await expect(
			call(winner, (s) =>
				s.publish({
					commandId: crypto.randomUUID(),
					claimId: claim.claimId,
					fence: claim.fence,
					attemptId: claim.attemptId,
					title: "stale",
					content: "stale",
				}),
			),
		).rejects.toBeInstanceOf(FenceConflict);

		const next = await call(agent, (s) =>
			s.claim({ commandId: crypto.randomUUID(), taskId, leaseSeconds: 60 }),
		);

		await query(
			"update grove_claims set issued_at=now()-interval '2 seconds', expires_at=now()-interval '1 second' where id=$1",
			[next.claimId],
		);

		await expect(
			call(agent, (s) =>
				s.publish({
					commandId: crypto.randomUUID(),
					claimId: next.claimId,
					fence: next.fence,
					attemptId: next.attemptId,
					title: "expired",
					content: "expired",
				}),
			),
		).rejects.toBeInstanceOf(FenceConflict);

		const recovered = await call(owner, (s) =>
			s.claim({ commandId: crypto.randomUUID(), taskId, leaseSeconds: 60 }),
		);

		expect(recovered.claimId).not.toBe(next.claimId);
		expect(recovered.fence).not.toBe(next.fence);
	});

	it("publishes through REST with exact replay without completing the Task or unblocking dependencies", async () => {
		const { project, plan } = await planProject();
		const taskId = plan.taskIds.first;

		expect(await call(owner, (s) => s.ready({ projectId: project.objectId }))).toMatchObject([
			{ taskId, title: "First", dependencyTaskIds: [] },
		]);

		const claim = await call(agent, (s) =>
			s.claim({ commandId: crypto.randomUUID(), taskId, leaseSeconds: 60 }),
		);
		const publication = {
			commandId: crypto.randomUUID(),
			claimId: claim.claimId,
			fence: claim.fence,
			attemptId: claim.attemptId,
			title: "Artifact",
			content: "Output, not completion",
		};
		const rest = () =>
			runtime.runPromise(
				groveApi
					.fetch(
						HttpServerRequest.fromWeb(
							new Request(`https://grove.example/api/v1/attempts/${claim.attemptId}/outputs`, {
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify(publication),
							}),
						),
					)
					.pipe(Effect.provideService(InvocationContext, { principal: agent })),
			);
		const response = await rest();

		expect(response.status).toBe(200);
		const published = await call(agent, (s) => s.publish(publication));

		expect(published.replayed).toBe(true);
		expect((await rest()).status).toBe(200);

		expect(await query("select status from grove_tasks where object_id=$1", [taskId])).toEqual([
			{ status: "planned" },
		]);

		expect(await query("select status from grove_attempts where id=$1", [claim.attemptId])).toEqual(
			[{ status: "result_submitted" }],
		);

		expect(await call(owner, (s) => s.ready({ projectId: project.objectId }))).toEqual([]);

		await expect(
			call(agent, (s) =>
				s.claim({ commandId: crypto.randomUUID(), taskId: plan.taskIds.second, leaseSeconds: 60 }),
			),
		).rejects.toBeInstanceOf(CommandConflict);
	});

	it("rolls back a failed publication including its Attempt transition, output, receipt and event", async () => {
		const { plan } = await planProject();
		const claim = await call(agent, (s) =>
			s.claim({ commandId: crypto.randomUUID(), taskId: plan.taskIds.first, leaseSeconds: 60 }),
		);
		const publication = {
			commandId: crypto.randomUUID(),
			claimId: claim.claimId,
			fence: claim.fence,
			attemptId: claim.attemptId,
			title: "Retry",
			content: "Must roll back",
		};
		const before = await counts();

		await query(
			"create function reject_output_event() returns trigger language plpgsql as $$ begin raise exception 'late publication failure'; end $$",
		);

		await query(
			"create trigger reject_output_event before insert on grove_outbox for each row execute function reject_output_event()",
		);

		try {
			await expect(call(agent, (s) => s.publish(publication))).rejects.toBeInstanceOf(
				ProjectDatabaseError,
			);

			expect(await counts()).toEqual(before);

			expect(
				await query("select status from grove_attempts where id=$1", [claim.attemptId]),
			).toEqual([{ status: "running" }]);

			expect(
				await query("select attempt_id from grove_attempt_outputs where attempt_id=$1", [
					claim.attemptId,
				]),
			).toEqual([]);
		} finally {
			await query("drop trigger reject_output_event on grove_outbox");
			await query("drop function reject_output_event()");
		}

		expect((await call(agent, (s) => s.publish(publication))).replayed).toBe(false);
	});

	it("enforces append-only Versions against update, delete, and truncate", async () => {
		const created = await call(owner, (s) => s.create(input()));
		const before = await counts();

		await expect(
			query("update grove_object_versions set payload='{}' where id=$1", [created.versionId]),
		).rejects.toBeDefined();

		await expect(
			query("delete from grove_object_versions where id=$1", [created.versionId]),
		).rejects.toBeDefined();

		await expect(query("truncate grove_object_versions cascade")).rejects.toBeDefined();
		expect(await counts()).toEqual(before);
	});

	it("uses live time after PostgreSQL lock waits and commits expired claim fencing", async () => {
		const { plan } = await planProject();
		const taskId = plan.taskIds.first;
		const claim = await call(agent, (s) =>
			s.claim({ commandId: crypto.randomUUID(), taskId, leaseSeconds: 1 }),
		);
		const acquired = Promise.withResolvers<undefined>();
		const release = Promise.withResolvers<undefined>();
		const transaction = database.runPromise(
			Effect.flatMap(PgClient.PgClient, (sql) =>
				sql.withTransaction(
					Effect.gen(function* () {
						yield* sql.unsafe(
							"select c.id from grove_claims c join grove_attempts a on a.id=c.attempt_id where c.id=$1 for update of c,a",
							[claim.claimId],
						);

						acquired.resolve(undefined);
						yield* Effect.promise(() => release.promise);
					}),
				),
			),
		);

		await acquired.promise;

		const pending = Promise.allSettled([
			call(agent, (s) =>
				s.renew({
					commandId: crypto.randomUUID(),
					claimId: claim.claimId,
					fence: claim.fence,
					leaseSeconds: 60,
				}),
			),
		]);

		try {
			await waitForLock();
			await delay(1200);
		} finally {
			release.resolve(undefined);
			await transaction;
		}

		const [result] = await pending;

		expect(result.status).toBe("rejected");

		if (result.status === "rejected") {
			expect(result.reason).toBeInstanceOf(FenceConflict);
		}

		expect(
			await query(
				"select c.status claim_status,a.status attempt_status from grove_claims c join grove_attempts a on a.id=c.attempt_id where c.id=$1",
				[claim.claimId],
			),
		).toEqual([{ claim_status: "expired", attempt_status: "fenced" }]);
	});

	it("rejects publication whose lease expires while waiting for the Task lock", async () => {
		const { plan } = await planProject();
		const taskId = plan.taskIds.first;
		const claim = await call(agent, (s) =>
			s.claim({ commandId: crypto.randomUUID(), taskId, leaseSeconds: 1 }),
		);
		const commandId = crypto.randomUUID();
		const before = await counts();
		const acquired = Promise.withResolvers<undefined>();
		const release = Promise.withResolvers<undefined>();
		const transaction = database.runPromise(
			Effect.flatMap(PgClient.PgClient, (sql) =>
				sql.withTransaction(
					Effect.gen(function* () {
						yield* sql.unsafe("select object_id from grove_tasks where object_id=$1 for update", [
							taskId,
						]);

						acquired.resolve(undefined);
						yield* Effect.promise(() => release.promise);
					}),
				),
			),
		);

		await acquired.promise;

		const pending = Promise.allSettled([
			call(agent, (s) =>
				s.publish({
					commandId,
					claimId: claim.claimId,
					fence: claim.fence,
					attemptId: claim.attemptId,
					title: "Too late",
					content: "Must not become an authoritative output",
				}),
			),
		]);

		try {
			await waitForLock();
			await delay(1200);
		} finally {
			release.resolve(undefined);
			await transaction;
		}

		const [result] = await pending;

		expect(result.status).toBe("rejected");

		if (result.status === "rejected") {
			expect(result.reason).toBeInstanceOf(FenceConflict);
		}

		expect(await counts()).toEqual(before);

		expect(
			await query(
				"select c.status claim_status,a.status attempt_status from grove_claims c join grove_attempts a on a.id=c.attempt_id where c.id=$1",
				[claim.claimId],
			),
		).toEqual([{ claim_status: "expired", attempt_status: "fenced" }]);
	});

	it("persists expiry recovery when the Task is no longer ready for a new Claim", async () => {
		const { plan } = await planProject();
		const taskId = plan.taskIds.first;
		const claim = await call(agent, (s) =>
			s.claim({ commandId: crypto.randomUUID(), taskId, leaseSeconds: 1 }),
		);

		// Represents an external governance decision; recovery must not depend on readiness.
		await query("update grove_tasks set status='completed' where object_id=$1", [taskId]);
		await delay(1200);
		const before = await counts();

		await expect(
			call(agent, (s) => s.claim({ commandId: crypto.randomUUID(), taskId, leaseSeconds: 60 })),
		).rejects.toBeInstanceOf(CommandConflict);

		expect(await counts()).toEqual(before);

		expect(
			await query(
				"select c.status claim_status,a.status attempt_status from grove_claims c join grove_attempts a on a.id=c.attempt_id where c.id=$1",
				[claim.claimId],
			),
		).toEqual([{ claim_status: "expired", attempt_status: "fenced" }]);
	});

	it("requires exact independent review and completion before dependency readiness and pins historical provenance", async () => {
		const { project, plan } = await planProject();
		const taskId = plan.taskIds.first;
		const [head] = await query<{ current_version_id: string }>(
			"select current_version_id from grove_objects where id=$1",
			[taskId],
		);
		const claim = await call(agent, (s) =>
			s.claim({ commandId: crypto.randomUUID(), taskId, leaseSeconds: 60 }),
		);
		const output = await call(agent, (s) =>
			s.publish({
				commandId: crypto.randomUUID(),
				claimId: claim.claimId,
				fence: claim.fence,
				attemptId: claim.attemptId,
				title: "Pinned",
				content: "searchable exact historical artifact",
			}),
		);
		const reviewInput = {
			commandId: crypto.randomUUID(),
			taskId,
			attemptId: claim.attemptId,
			objectId: output.objectId,
			versionId: output.versionId,
			outcome: "accepted" as const,
			comments: "Verified exact output",
		};

		await expect(call(agent, (s) => s.review(reviewInput))).rejects.toBeInstanceOf(CommandConflict);

		await Promise.all(
			["taskId", "attemptId", "objectId", "versionId"].map((field) =>
				expect(
					call(reviewer, (s) => s.review({ ...reviewInput, [field]: crypto.randomUUID() })),
				).rejects.toBeInstanceOf(CommandConflict),
			),
		);

		expect(
			await call(owner, (s) => s.search({ projectId: project.objectId, query: "historical" })),
		).toEqual([]);

		const review = await call(reviewer, (s) => s.review(reviewInput));

		expect(await call(reviewer, (s) => s.review(reviewInput))).toEqual({
			...review,
			replayed: true,
		});

		expect(
			(await call(owner, (s) => s.ready({ projectId: project.objectId }))).some(
				(r) => r.taskId === plan.taskIds.second,
			),
		).toBe(false);

		const completionInput = {
			commandId: crypto.randomUUID(),
			taskId,
			expectedVersionId: head.current_version_id,
		};

		await expect(
			call(owner, (s) =>
				s.claim({ commandId: crypto.randomUUID(), taskId: plan.taskIds.second, leaseSeconds: 60 }),
			),
		).rejects.toBeInstanceOf(CommandConflict);

		const completed = await call(owner, (s) => s.complete(completionInput));

		expect(await call(owner, (s) => s.complete(completionInput))).toEqual({
			...completed,
			replayed: true,
		});

		await expect(
			call(owner, (s) => s.complete({ ...completionInput, commandId: crypto.randomUUID() })),
		).rejects.toBeInstanceOf(CommandConflict);

		expect(
			(await call(owner, (s) => s.ready({ projectId: project.objectId }))).some(
				(r) => r.taskId === plan.taskIds.second,
			),
		).toBe(true);

		const search = await call(owner, (s) =>
			s.search({ projectId: project.objectId, query: "historical" }),
		);

		expect(search).toHaveLength(1);

		expect(search[0]).toMatchObject({
			objectId: output.objectId,
			versionId: output.versionId,
			reviewerId: reviewer.actorId,
			reviewerKind: "person",
		});

		const pinnedInput = {
			projectId: project.objectId,
			objectId: output.objectId,
			versionId: output.versionId,
		};
		const pinned = await call(owner, (s) => s.getVersion(pinnedInput));

		expect(pinned).toMatchObject({
			authorId: agent.actorId,
			authorKind: "agent",
			reviewId: review.reviewId,
			reviewVersionId: review.reviewVersionId,
		});

		const laterVersion = crypto.randomUUID();
		const payload = { type: "artifact", title: "Later", content: "new head" };

		await query(
			"insert into grove_object_versions(id,object_id,parent_version_id,payload,digest,actor_id,actor_kind) values($1,$2,$3,$4,$5,$6,'person');",
			[
				laterVersion,
				output.objectId,
				output.versionId,
				JSON.stringify(payload),
				await Effect.runPromise(canonicalDigest(payload)),
				owner.actorId,
			],
		);

		await query("update grove_objects set current_version_id=$2 where id=$1", [
			output.objectId,
			laterVersion,
		]);

		expect(
			await call(owner, (s) => s.search({ projectId: project.objectId, query: "historical" })),
		).toEqual(search);

		expect(await call(owner, (s) => s.getVersion(pinnedInput))).toEqual(pinned);
		const other = await call(owner, (s) => s.create(input()));

		await expect(
			call(owner, (s) => s.getVersion({ ...pinnedInput, projectId: other.objectId })),
		).rejects.toBeInstanceOf(CommandConflict);
	});

	it("rechecks artifact heads after lock contention in review and completion", async () => {
		const { plan } = await planProject();
		const taskId = plan.taskIds.first;
		const claim = await call(agent, (s) =>
			s.claim({ commandId: crypto.randomUUID(), taskId, leaseSeconds: 60 }),
		);
		const output = await call(agent, (s) =>
			s.publish({
				commandId: crypto.randomUUID(),
				claimId: claim.claimId,
				fence: claim.fence,
				attemptId: claim.attemptId,
				title: "Race",
				content: "Exact head",
			}),
		);
		const later = crypto.randomUUID();
		const payload = { type: "artifact", title: "Changed", content: "unreviewed" };

		await query(
			"insert into grove_object_versions(id,object_id,parent_version_id,payload,digest,actor_id,actor_kind) values($1,$2,$3,$4,$5,$6,'person')",
			[
				later,
				output.objectId,
				output.versionId,
				JSON.stringify(payload),
				await Effect.runPromise(canonicalDigest(payload)),
				owner.actorId,
			],
		);

		const reviewInput = {
			commandId: crypto.randomUUID(),
			taskId,
			attemptId: claim.attemptId,
			objectId: output.objectId,
			versionId: output.versionId,
			outcome: "accepted" as const,
		};
		const contend = async (operation: () => Promise<unknown>) => {
			const acquired = Promise.withResolvers<undefined>();
			const release = Promise.withResolvers<undefined>();
			const transaction = database.runPromise(
				Effect.flatMap(PgClient.PgClient, (sql) =>
					sql.withTransaction(
						Effect.gen(function* () {
							yield* sql.unsafe("select id from grove_objects where id=$1 for update", [
								output.objectId,
							]);

							acquired.resolve(undefined);
							yield* Effect.promise(() => release.promise);

							yield* sql.unsafe("update grove_objects set current_version_id=$2 where id=$1", [
								output.objectId,
								later,
							]);
						}),
					),
				),
			);

			await acquired.promise;
			const pending = Promise.allSettled([operation()]);

			try {
				await waitForLock();
			} finally {
				release.resolve(undefined);
				await transaction;
			}

			const [result] = await pending;

			expect(result.status).toBe("rejected");

			if (result.status === "rejected") {
				expect(result.reason).toBeInstanceOf(CommandConflict);
			}

			await query("update grove_objects set current_version_id=$2 where id=$1", [
				output.objectId,
				output.versionId,
			]);
		};

		await contend(() => call(reviewer, (s) => s.review(reviewInput)));
		await call(reviewer, (s) => s.review(reviewInput));

		const [head] = await query<{ current_version_id: string }>(
			"select current_version_id from grove_objects where id=$1",
			[taskId],
		);

		await contend(() =>
			call(owner, (s) =>
				s.complete({
					commandId: crypto.randomUUID(),
					taskId,
					expectedVersionId: head.current_version_id,
				}),
			),
		);
	});

	it("allows rejection retry while excluding rejected provenance from the library", async () => {
		const { project, plan } = await planProject();
		const taskId = plan.taskIds.first;
		const claim = await call(agent, (s) =>
			s.claim({ commandId: crypto.randomUUID(), taskId, leaseSeconds: 60 }),
		);
		const output = await call(agent, (s) =>
			s.publish({
				commandId: crypto.randomUUID(),
				claimId: claim.claimId,
				fence: claim.fence,
				attemptId: claim.attemptId,
				title: "Rejected",
				content: "Rejected evidence",
			}),
		);

		await call(reviewer, (s) =>
			s.review({
				commandId: crypto.randomUUID(),
				taskId,
				attemptId: claim.attemptId,
				objectId: output.objectId,
				versionId: output.versionId,
				outcome: "rejected",
			}),
		);

		const retry = await call(agent, (s) =>
			s.claim({ commandId: crypto.randomUUID(), taskId, leaseSeconds: 60 }),
		);

		expect(retry.attemptId).not.toBe(claim.attemptId);

		await expect(
			call(reviewer, (s) =>
				s.review({
					commandId: crypto.randomUUID(),
					taskId,
					attemptId: claim.attemptId,
					objectId: output.objectId,
					versionId: output.versionId,
					outcome: "accepted",
				}),
			),
		).rejects.toBeInstanceOf(CommandConflict);

		expect(
			await call(owner, (s) => s.search({ projectId: project.objectId, query: "Rejected" })),
		).toEqual([]);
	});

	it("denies cached command replay after revocation and rejects unenrolled machines without writes", async () => {
		const command = input();

		await call(agent, (s) => s.create(command));

		await runtime.runPromise(
			Effect.flatMap(ActorAuthority, (a) =>
				a.applyContainmentFixAs(owner, {
					action: "remove-agent-capability",
					agentId: agent.actorId,
					personId: owner.actorId,
					capability: "project.create",
				}),
			),
		);

		const before = await counts();

		await expect(call(agent, (s) => s.create(command))).rejects.toMatchObject({
			_tag: "ActorDenied",
		});

		const machine = await runtime.runPromise(
			Effect.flatMap(ActorAuthority, (a) =>
				a.resolveMachineIdentity({
					issuer: "https://machine.example",
					subject: "not-enrolled",
					scopes: new Set(["grove:mcp"]),
				}),
			),
		);

		await expect(
			runtime.runPromise(
				Effect.flatMap(ProjectService, (s) => s.create(input())).pipe(
					Effect.provideService(InvocationContext, { principal: machine }),
				),
			),
		).rejects.toMatchObject({ _tag: "ActorDenied" });

		expect(await counts()).toEqual(before);
	});
});
