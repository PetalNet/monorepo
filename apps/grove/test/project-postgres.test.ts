import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import * as PgClient from "@effect/sql-pg/PgClient";
import { SvelteKitRequestEvent } from "@petalnet/effect-sveltekit";
import type { RequestEvent } from "@sveltejs/kit";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ProjectCreate } from "../src/lib/projects/schema";
import { groveApi } from "../src/lib/server/grove/api";
import { canonicalDigest } from "../src/lib/server/projects/canonical";
import {
	CommandConflict,
	FenceConflict,
	ProjectDatabaseError,
	ProjectService,
	ProjectServiceLayer,
	type ProjectServiceShape,
} from "../src/lib/server/projects/service";
import { SproutServiceBuildLayer } from "../src/lib/server/sprouts/service";

const input = (commandId: string = randomUUID()) => ({
	commandId,
	scope: "team/core",
	title: "Ship Grove",
	ask: "Create the object foundation",
});

const principalEvent = (principalId = "principal-a") =>
	({
		url: new URL("https://grove.test/api/v1/projects"),
		locals: { mcpPrincipal: null, session: null, user: { id: principalId } },
	}) as RequestEvent;
const delay = (milliseconds: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

describe("ProjectService PostgreSQL integration", async () => {
	const upgradeCommand = input();
	const upgradeObjectId = randomUUID();
	const upgradeVersionId = randomUUID();
	const container = await new PostgreSqlContainer("postgres:17-alpine").start();
	const postgres = PgClient.layer({ url: Redacted.make(container.getConnectionUri()) });
	const runtime = ManagedRuntime.make(
		Layer.merge(ProjectServiceLayer.pipe(Layer.provide(postgres)), postgres),
	);

	beforeAll(async () => {
		const migration = await readFile(
			new URL("../migrations/0003_objects.sql", import.meta.url),
			"utf8",
		);
		const [upMigration] = migration.split("-- effect-db:down");
		const up = upMigration.replace("-- effect-db:up", "");
		await query(up);
		const payload = {
			scope: upgradeCommand.scope,
			title: upgradeCommand.title,
			task: upgradeCommand.ask,
		};
		const versionPayload = { type: "project", ...payload };
		await query(`insert into grove_objects(id,kind,scope) values('${upgradeObjectId}','task','${upgradeCommand.scope}');
			insert into grove_object_versions(id,object_id,payload,digest,actor_id,actor_kind) values('${upgradeVersionId}','${upgradeObjectId}','${JSON.stringify(versionPayload)}','${canonicalDigest(versionPayload)}','principal-a','human');
			update grove_objects set current_version_id='${upgradeVersionId}' where id='${upgradeObjectId}';
			insert into grove_project_tasks(object_id) values('${upgradeObjectId}');
			insert into grove_command_receipts(command_id,operation,principal_id,principal_kind,input_hash,object_id,version_id,version_digest) values('${upgradeCommand.commandId}','project.create','principal-a','human','${canonicalDigest(payload)}','${upgradeObjectId}','${upgradeVersionId}','${canonicalDigest(versionPayload)}');
			insert into grove_outbox(id,command_id,version_id,event_type,aggregate_id,payload) values('${randomUUID()}','${upgradeCommand.commandId}','${upgradeVersionId}','project.created','${upgradeObjectId}','{}')`);
		const taskMigration = await readFile(
			new URL("../migrations/0004_task_execution.sql", import.meta.url),
			"utf8",
		);
		await query(taskMigration.split("-- effect-db:down")[0].replace("-- effect-db:up", ""));
		const reviewMigration = await readFile(
			new URL("../migrations/0005_review_library.sql", import.meta.url),
			"utf8",
		);
		await query(reviewMigration.split("-- effect-db:down")[0].replace("-- effect-db:up", ""));
	}, 60_000);

	afterAll(async () => {
		await runtime.dispose();
		await container.stop();
	});

	const query = <Row extends object = Record<string, unknown>>(sqlText: string) =>
		runtime.runPromise(Effect.flatMap(PgClient.PgClient, (sql) => sql.unsafe<Row>(sqlText)));

	const create = (
		command: ProjectCreate,
		principalId = "principal-a",
		kind: "human" | "mcp" = "human",
	) => {
		const requestEvent = {
			url: new URL(
				kind === "mcp" ? "https://grove.test/mcp" : "https://grove.test/api/v1/projects",
			),
			locals: {
				mcpPrincipal:
					kind === "mcp" ? { subject: principalId, scopes: new Set(["grove:mcp"]) } : null,
				session: null,
				user: kind === "human" ? { id: principalId } : null,
			},
		} as RequestEvent;
		return runtime.runPromise(
			Effect.flatMap(ProjectService, (service) => service.create(command)).pipe(
				Effect.provideService(SvelteKitRequestEvent, requestEvent),
			),
		);
	};
	it("upgrades an open 0003 project and preserves #359 project.create replay", async () => {
		expect(await create(upgradeCommand)).toEqual(
			expect.objectContaining({
				objectId: upgradeObjectId,
				versionId: upgradeVersionId,
				replayed: true,
			}),
		);
		expect(
			await query<{ status: string }>(
				`select status from grove_tasks where object_id='${upgradeObjectId}'`,
			),
		).toEqual([{ status: "planning" }]);
	});

	it("enforces reviewed completion and exposes only exact accepted completed provenance", async () => {
		const runAs = <A, E>(
			principalId: string,
			kind: "human" | "mcp",
			effect: Effect.Effect<A, E, SvelteKitRequestEvent | ProjectService>,
		) =>
			runtime.runPromise(
				effect.pipe(
					Effect.provideService(
						SvelteKitRequestEvent,
						kind === "human"
							? principalEvent(principalId)
							: ({
									url: new URL("https://grove.test/mcp"),
									locals: {
										mcpPrincipal: { subject: principalId, scopes: new Set(["grove:mcp"]) },
										session: null,
										user: null,
									},
								} as unknown as RequestEvent),
					),
				),
			);
		const call = <A, E>(
			principalId: string,
			kind: "human" | "mcp",
			invoke: (service: ProjectServiceShape) => Effect.Effect<A, E, SvelteKitRequestEvent>,
		) => runAs(principalId, kind, Effect.flatMap(ProjectService, invoke));
		const advanceArtifactWhileLifecycleWaits = async <A>(
			objectId: string,
			versionId: string,
			lifecycle: () => Promise<A>,
		) => {
			const { promise: locked, resolve: signalLocked } = Promise.withResolvers<undefined>();
			const { promise: advanceRequested, resolve: advance } = Promise.withResolvers<undefined>();
			const transaction = runtime.runPromise(
				Effect.flatMap(PgClient.PgClient, (sql) =>
					sql.withTransaction(
						Effect.gen(function* () {
							yield* sql.unsafe("select id from grove_objects where id=$1 for update", [objectId]);
							signalLocked(undefined);
							yield* Effect.promise(() => advanceRequested);
							yield* sql.unsafe("update grove_objects set current_version_id=$2 where id=$1", [
								objectId,
								versionId,
							]);
						}),
					),
				),
			);
			await locked;
			let settled = false;
			const pending = lifecycle();
			void pending.then(
				() => (settled = true),
				() => (settled = true),
			);
			const deadline = Date.now() + 5_000;
			const waitForArtifactLock = async (): Promise<void> => {
				const rows = await query<{ waiting: boolean }>(
					"select exists(select 1 from pg_stat_activity where datname=current_database() and state='active' and wait_event_type='Lock' and query not like '%pg_stat_activity%') waiting",
				);
				if (rows[0].waiting) return;
				if (Date.now() >= deadline) throw new Error("Timed out waiting for artifact row lock");
				await delay(20);
				return waitForArtifactLock();
			};
			try {
				await waitForArtifactLock();
				expect(settled).toBe(false);
			} finally {
				advance(undefined);
				await transaction;
			}
			const [result] = await Promise.allSettled([pending]);
			expect(result.status).toBe("rejected");
			if (result.status === "rejected") expect(result.reason).toBeInstanceOf(CommandConflict);
		};
		const project = await create(input(), "worker");
		const plan = await call("worker", "human", (s) =>
			s.plan({
				commandId: randomUUID(),
				projectId: project.objectId,
				expectedVersionId: project.versionId,
				tasks: [
					{
						key: "work",
						title: "Reviewed",
						objective: "Lifecycle",
						completionContract: { requiredOutputs: ["artifact"], reviewRequired: true },
					},
				],
				dependencies: [],
			}),
		);
		const taskId = plan.taskIds.work;
		const [taskHead] = await query<{ current_version_id: string }>(
			`select current_version_id from grove_objects where id='${taskId}'`,
		);
		const claim = await call("shared", "human", (s) =>
			s.claim({ commandId: randomUUID(), taskId, leaseSeconds: 60 }),
		);
		const output = await call("shared", "human", (s) =>
			s.publish({
				commandId: randomUUID(),
				claimId: claim.claimId,
				fence: claim.fence,
				attemptId: claim.attemptId,
				title: "Pinned provenance",
				content: "accepted searchable lifecycle",
			}),
		);
		expect(
			await call("reader", "human", (s) =>
				s.search({ projectId: project.objectId, query: "lifecycle" }),
			),
		).toEqual([]);
		const reviewInput = {
			commandId: randomUUID(),
			taskId,
			attemptId: claim.attemptId,
			objectId: output.objectId,
			versionId: output.versionId,
			outcome: "accepted" as const,
		};
		await expect(call("shared", "human", (s) => s.review(reviewInput))).rejects.toBeInstanceOf(
			CommandConflict,
		);
		await expect(
			call("reviewer", "human", (s) =>
				s.review({ ...reviewInput, commandId: randomUUID(), taskId: randomUUID() }),
			),
		).rejects.toBeInstanceOf(CommandConflict);
		await expect(
			call("reviewer", "human", (s) =>
				s.review({ ...reviewInput, commandId: randomUUID(), attemptId: randomUUID() }),
			),
		).rejects.toBeInstanceOf(CommandConflict);
		await expect(
			call("reviewer", "human", (s) =>
				s.review({ ...reviewInput, commandId: randomUUID(), objectId: randomUUID() }),
			),
		).rejects.toBeInstanceOf(CommandConflict);
		await expect(
			call("reviewer", "human", (s) =>
				s.review({ ...reviewInput, commandId: randomUUID(), versionId: randomUUID() }),
			),
		).rejects.toBeInstanceOf(CommandConflict);
		const staleReviewVersion = randomUUID();
		const staleReviewPayload = { type: "artifact", title: "new head", content: "unsubmitted" };
		await query(
			`insert into grove_object_versions(id,object_id,parent_version_id,payload,digest,actor_id,actor_kind) values('${staleReviewVersion}','${output.objectId}','${output.versionId}','${JSON.stringify(staleReviewPayload)}','${canonicalDigest(staleReviewPayload)}','other','human')`,
		);
		await advanceArtifactWhileLifecycleWaits(output.objectId, staleReviewVersion, () =>
			call("reviewer", "human", (s) => s.review({ ...reviewInput, commandId: randomUUID() })),
		);
		await query(
			`update grove_objects set current_version_id='${output.versionId}' where id='${output.objectId}'`,
		);
		// IDs are namespaced by principal kind: the executor's ID as MCP is a distinct reviewer.
		const review = await call("shared", "mcp", (s) => s.review(reviewInput));
		expect(
			await call("reader", "human", (s) =>
				s.search({ projectId: project.objectId, query: "lifecycle" }),
			),
		).toEqual([]);
		await expect(
			call("late-worker", "human", (s) =>
				s.claim({ commandId: randomUUID(), taskId, leaseSeconds: 60 }),
			),
		).rejects.toBeInstanceOf(CommandConflict);
		expect(
			(await call("reader", "human", (s) => s.ready({ projectId: project.objectId }))).some(
				(task) => task.taskId === taskId,
			),
		).toBe(false);
		expect(await call("shared", "mcp", (s) => s.review(reviewInput))).toEqual({
			...review,
			replayed: true,
		});
		await expect(
			call("reviewer", "human", (s) => s.review({ ...reviewInput, commandId: randomUUID() })),
		).rejects.toBeInstanceOf(CommandConflict);
		await expect(
			query(`update grove_reviews set outcome='rejected' where object_id='${review.reviewId}'`),
		).rejects.toBeDefined();
		const mismatchedReviewId = randomUUID();
		const mismatchedReviewVersionId = randomUUID();
		await query(
			`insert into grove_objects(id,kind,scope) values('${mismatchedReviewId}','review','team/core');
			 insert into grove_object_versions(id,object_id,payload,digest,actor_id,actor_kind)
			 values('${mismatchedReviewVersionId}','${mismatchedReviewId}','{}','${canonicalDigest({})}','shared','mcp')`,
		);
		await expect(
			query(
				`insert into grove_reviews(object_id,version_id,reviewer_id,reviewer_kind,subject_object_id,subject_version_id,attempt_id,task_id,outcome)
				 values('${mismatchedReviewId}','${mismatchedReviewVersionId}','shared','mcp','${output.objectId}','${output.versionId}','${claim.attemptId}','${taskId}','accepted')`,
			),
		).rejects.toBeDefined();
		await expect(
			query(
				`update grove_attempt_outputs set version_id='${randomUUID()}' where attempt_id='${claim.attemptId}'`,
			),
		).rejects.toBeDefined();
		await expect(
			query(`update grove_attempts set executor_id='other' where id='${claim.attemptId}'`),
		).rejects.toBeDefined();

		await expect(
			call("finisher", "human", (s) =>
				s.complete({ commandId: randomUUID(), taskId, expectedVersionId: randomUUID() }),
			),
		).rejects.toBeInstanceOf(CommandConflict);
		const staleArtifactVersion = randomUUID();
		const staleArtifactPayload = { type: "artifact", title: "changed", content: "unreviewed" };
		await query(
			`insert into grove_object_versions(id,object_id,parent_version_id,payload,digest,actor_id,actor_kind) values('${staleArtifactVersion}','${output.objectId}','${output.versionId}','${JSON.stringify(staleArtifactPayload)}','${canonicalDigest(staleArtifactPayload)}','other','human')`,
		);
		await advanceArtifactWhileLifecycleWaits(output.objectId, staleArtifactVersion, () =>
			call("finisher", "human", (s) =>
				s.complete({
					commandId: randomUUID(),
					taskId,
					expectedVersionId: taskHead.current_version_id,
				}),
			),
		);
		await query(
			`update grove_objects set current_version_id='${output.versionId}' where id='${output.objectId}'`,
		);
		const completionInput = {
			commandId: randomUUID(),
			taskId,
			expectedVersionId: taskHead.current_version_id,
		};
		const concurrent = await Promise.allSettled([
			call("finisher", "human", (s) => s.complete(completionInput)),
			call("finisher", "human", (s) => s.complete({ ...completionInput, commandId: randomUUID() })),
		]);
		expect(concurrent.filter((x) => x.status === "fulfilled")).toHaveLength(1);
		expect(concurrent.filter((x) => x.status === "rejected")).toHaveLength(1);
		const completedResult = concurrent.find((result) => result.status === "fulfilled");
		if (!completedResult) throw new Error("Expected one successful concurrent completion");
		const completed = completedResult.value;
		const usedInput =
			completed.commandId === completionInput.commandId
				? completionInput
				: { ...completionInput, commandId: completed.commandId };
		expect(await call("finisher", "human", (s) => s.complete(usedInput))).toEqual({
			...completed,
			replayed: true,
		});
		const laterTaskVersion = randomUUID();
		const laterTaskPayload = { type: "task", status: "archived" };
		await query(
			`insert into grove_object_versions(id,object_id,parent_version_id,payload,digest,actor_id,actor_kind)
			 values('${laterTaskVersion}','${taskId}','${completed.versionId}','${JSON.stringify(laterTaskPayload)}','${canonicalDigest(laterTaskPayload)}','finisher','human');
			 update grove_objects set current_version_id='${laterTaskVersion}' where id='${taskId}'`,
		);
		expect(
			await query<{ parent_version_id: string; completion: Record<string, unknown> }>(
				`select parent_version_id,payload->'completion' completion from grove_object_versions where id='${completed.versionId}'`,
			),
		).toEqual([
			{
				parent_version_id: taskHead.current_version_id,
				completion: {
					attemptId: claim.attemptId,
					output: { objectId: output.objectId, versionId: output.versionId },
					review: { objectId: review.reviewId, versionId: review.reviewVersionId },
				},
			},
		]);

		expect(
			await call("reader", "human", (s) => s.search({ projectId: taskId, query: "lifecycle" })),
		).toEqual([]);
		const results = await call("reader", "human", (s) =>
			s.search({ projectId: project.objectId, query: "lifecycle" }),
		);
		expect(results).toEqual([
			expect.objectContaining({
				objectId: output.objectId,
				versionId: output.versionId,
				reviewVersionId: review.reviewVersionId,
				reviewOutcome: "accepted",
				reviewerId: "shared",
				reviewerKind: "mcp",
			}),
		]);
		const restEvent = principalEvent("rest-reader");
		const restResponse = await runtime.runPromise(
			groveApi
				.fetch(
					new Request(
						`https://grove.test/api/v1/library/search?projectId=${project.objectId}&query=lifecycle`,
					),
				)
				.pipe(
					Effect.provide(SproutServiceBuildLayer),
					Effect.provideService(SvelteKitRequestEvent, restEvent),
				),
		);
		expect(restResponse.status).toBe(200);
		expect(await restResponse.json()).toEqual(results);
		const pinned = await call("reader", "human", (s) =>
			s.getVersion({
				projectId: project.objectId,
				objectId: output.objectId,
				versionId: output.versionId,
			}),
		);
		const otherProject = await create(input(), "reader");
		await expect(
			call("reader", "human", (s) =>
				s.getVersion({
					projectId: otherProject.objectId,
					objectId: output.objectId,
					versionId: output.versionId,
				}),
			),
		).rejects.toBeInstanceOf(CommandConflict);
		expect(pinned).toEqual(
			expect.objectContaining({
				taskId,
				attemptId: claim.attemptId,
				authorId: "shared",
				authorKind: "human",
				reviewId: review.reviewId,
				reviewVersionId: review.reviewVersionId,
				reviewOutcome: "accepted",
				reviewerId: "shared",
				reviewerKind: "mcp",
			}),
		);
		const restPinnedResponse = await runtime.runPromise(
			groveApi
				.fetch(
					new Request(
						`https://grove.test/api/v1/library/objects/${output.objectId}/versions/${output.versionId}?projectId=${project.objectId}`,
					),
				)
				.pipe(
					Effect.provide(SproutServiceBuildLayer),
					Effect.provideService(SvelteKitRequestEvent, restEvent),
				),
		);
		expect(restPinnedResponse.status).toBe(200);
		expect(await restPinnedResponse.json()).toEqual(pinned);
		const mcpResponse = await runtime.runPromise(
			groveApi
				.mcp({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: {
						name: "library.getVersion",
						arguments: {
							projectId: project.objectId,
							objectId: output.objectId,
							versionId: output.versionId,
						},
					},
				})
				.pipe(
					Effect.provide(SproutServiceBuildLayer),
					Effect.provideService(SvelteKitRequestEvent, {
						url: new URL("https://grove.test/mcp"),
						locals: {
							mcpPrincipal: { subject: "mcp-reader", scopes: new Set(["grove:mcp"]) },
							session: null,
							user: null,
						},
					} as unknown as RequestEvent),
				),
		);
		expect(await mcpResponse.json()).toMatchObject({
			result: { isError: false, structuredContent: pinned },
		});
		const laterVersion = randomUUID();
		const laterPayload = { type: "artifact", title: "later", content: "later" };
		await query(
			`insert into grove_object_versions(id,object_id,parent_version_id,payload,digest,actor_id,actor_kind) values('${laterVersion}','${output.objectId}','${output.versionId}','${JSON.stringify(laterPayload)}','${canonicalDigest(laterPayload)}','other','human'); update grove_objects set current_version_id='${laterVersion}' where id='${output.objectId}'`,
		);
		expect(
			(
				await call("reader", "human", (s) =>
					s.getVersion({
						projectId: project.objectId,
						objectId: output.objectId,
						versionId: output.versionId,
					}),
				)
			).versionId,
		).toBe(output.versionId);

		const rejectedProject = await create(input(), "reject-worker");
		const rejectedPlan = await call("reject-worker", "human", (s) =>
			s.plan({
				commandId: randomUUID(),
				projectId: rejectedProject.objectId,
				expectedVersionId: rejectedProject.versionId,
				tasks: [
					{
						key: "work",
						title: "Rejected",
						objective: "Retry",
						completionContract: { requiredOutputs: ["artifact"], reviewRequired: true },
					},
				],
				dependencies: [],
			}),
		);
		const rejectedTask = rejectedPlan.taskIds.work;
		const rejectedClaim = await call("reject-worker", "human", (s) =>
			s.claim({ commandId: randomUUID(), taskId: rejectedTask, leaseSeconds: 60 }),
		);
		const rejectedOutput = await call("reject-worker", "human", (s) =>
			s.publish({
				commandId: randomUUID(),
				claimId: rejectedClaim.claimId,
				fence: rejectedClaim.fence,
				attemptId: rejectedClaim.attemptId,
				title: "Rejected searchable",
				content: "must stay hidden",
			}),
		);
		await call("independent-reviewer", "human", (s) =>
			s.review({
				commandId: randomUUID(),
				taskId: rejectedTask,
				attemptId: rejectedClaim.attemptId,
				objectId: rejectedOutput.objectId,
				versionId: rejectedOutput.versionId,
				outcome: "rejected",
			}),
		);
		const [releasedClaim] = await query<{ status: string; released_at: string | null }>(
			`select status,released_at::text from grove_claims where id='${rejectedClaim.claimId}'`,
		);
		expect(releasedClaim.status).toBe("released");
		expect(releasedClaim.released_at).toEqual(expect.any(String));
		const retry = await call("retry-worker", "human", (s) =>
			s.claim({ commandId: randomUUID(), taskId: rejectedTask, leaseSeconds: 60 }),
		);
		expect(retry.attemptId).not.toBe(rejectedClaim.attemptId);
		const retryOutput = await call("retry-worker", "human", (s) =>
			s.publish({
				commandId: randomUUID(),
				claimId: retry.claimId,
				fence: retry.fence,
				attemptId: retry.attemptId,
				title: "Accepted retry",
				content: "retry is searchable",
			}),
		);
		await call("retry-reviewer", "human", (s) =>
			s.review({
				commandId: randomUUID(),
				taskId: rejectedTask,
				attemptId: retry.attemptId,
				objectId: retryOutput.objectId,
				versionId: retryOutput.versionId,
				outcome: "accepted",
			}),
		);
		const [retryTaskHead] = await query<{ current_version_id: string }>(
			`select current_version_id from grove_objects where id='${rejectedTask}'`,
		);
		await call("retry-finisher", "human", (s) =>
			s.complete({
				commandId: randomUUID(),
				taskId: rejectedTask,
				expectedVersionId: retryTaskHead.current_version_id,
			}),
		);
		expect(
			await call("reader", "human", (s) =>
				s.search({ projectId: rejectedProject.objectId, query: "searchable" }),
			),
		).toEqual([expect.objectContaining({ objectId: retryOutput.objectId })]);
	}, 15_000);

	it("rejects orphan commands and mismatched aggregate/version outbox rows", async () => {
		const project = await create(input());
		await expect(
			query(
				`insert into grove_outbox(id,command_id,version_id,event_type,aggregate_id,payload) values('${randomUUID()}','${randomUUID()}','${project.versionId}','bad','${project.objectId}','{}')`,
			),
		).rejects.toBeDefined();
		const other = await create(input());
		await expect(
			query(
				`insert into grove_outbox(id,command_id,version_id,event_type,aggregate_id,payload) values('${randomUUID()}','${project.commandId}','${other.versionId}','bad','${project.objectId}','{}')`,
			),
		).rejects.toBeDefined();
	});

	it("atomically creates one object, head Version, project Task, receipt, and outbox", async () => {
		const receipt = await create(input());
		expect(receipt.replayed).toBe(false);
		const rows = await query<{
			current_version_id: string;
			role: string;
			status: string;
			operation: string;
			principal_id: string;
			command_id: string;
			version_id: string;
		}>(`select o.current_version_id, t.role, t.status, r.operation, r.principal_id,
			x.command_id::text, x.version_id
			from grove_objects o join grove_object_versions v on v.object_id = o.id
			join grove_tasks t on t.object_id = o.id
			join grove_command_receipts r on r.object_id = o.id
			join grove_outbox x on x.command_id = r.command_id
			where o.id = '${receipt.objectId}'`);
		expect(rows).toEqual([
			expect.objectContaining({
				current_version_id: receipt.versionId,
				version_id: receipt.versionId,
				role: "project",
				status: "planning",
				operation: "project.create",
				principal_id: "principal-a",
			}),
		]);
	});

	it("replays identically without duplicates and conflicts on changed input or principal", async () => {
		const command = input();
		const first = await create(command);
		expect(await create(command)).toEqual({ ...first, replayed: true });
		await expect(create({ ...command, title: "Changed" })).rejects.toBeInstanceOf(CommandConflict);
		await expect(create(command, "principal-b")).rejects.toBeInstanceOf(CommandConflict);
		const counts = await query<{
			objects: number;
			versions: number;
			receipts: number;
			events: number;
		}>(
			`select (select count(*)::int from grove_objects where id = '${first.objectId}') objects,
			(select count(*)::int from grove_object_versions where object_id = '${first.objectId}') versions,
			(select count(*)::int from grove_command_receipts where object_id = '${first.objectId}') receipts,
			(select count(*)::int from grove_outbox where aggregate_id = '${first.objectId}') events`,
		);
		expect(counts[0]).toEqual({ objects: 1, versions: 1, receipts: 1, events: 1 });
	});

	it("serializes concurrent replay and conflict attempts", async () => {
		const command = input();
		const identical = await Promise.all([create(command), create(command)]);
		expect(identical.map(({ replayed }) => replayed).toSorted()).toEqual([false, true]);
		expect(new Set(identical.map(({ objectId }) => objectId)).size).toBe(1);

		const conflicting = input();
		const results = await Promise.allSettled([
			create(conflicting),
			create({ ...conflicting, title: "Different concurrent input" }),
		]);
		expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
		expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
		const rejected = results.find(({ status }) => status === "rejected");
		expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(CommandConflict);
	});

	it("normalizes UUID case and keeps principal namespaces distinct", async () => {
		const command = input(randomUUID().toUpperCase());
		const first = await create(command, "shared-id");
		expect(first.commandId).toBe(command.commandId.toLowerCase());
		expect(
			await create({ ...command, commandId: command.commandId.toLowerCase() }, "shared-id"),
		).toEqual({
			...first,
			replayed: true,
		});
		await expect(create(command, "shared-id", "mcp")).rejects.toBeInstanceOf(CommandConflict);
	});

	it("enforces append-only Versions for direct updates, deletes, and truncation", async () => {
		const receipt = await create(input());
		await expect(
			query(
				`update grove_object_versions set actor_id = 'other' where id = '${receipt.versionId}'`,
			),
		).rejects.toBeDefined();
		await expect(
			query(`delete from grove_object_versions where id = '${receipt.versionId}'`),
		).rejects.toBeDefined();
		await expect(query("truncate grove_object_versions cascade")).rejects.toBeDefined();
		expect(
			await query<{ actor_id: string }>(
				`select actor_id from grove_object_versions where id = '${receipt.versionId}'`,
			),
		).toEqual([{ actor_id: "principal-a" }]);
	});

	it("rolls the complete transaction back when a late database write fails", async () => {
		await query(`create function grove_test_fail_receipt() returns trigger language plpgsql as $$ begin
			raise exception 'forced receipt failure'; end $$;
			create trigger grove_test_fail_receipt before insert on grove_command_receipts
			for each row execute function grove_test_fail_receipt()`);
		const countAll = () =>
			query<{ objects: number; versions: number; tasks: number; receipts: number; outbox: number }>(
				`select (select count(*)::int from grove_objects) objects,
			(select count(*)::int from grove_object_versions) versions,
			(select count(*)::int from grove_tasks) tasks,
			(select count(*)::int from grove_command_receipts) receipts,
			(select count(*)::int from grove_outbox) outbox`,
			);
		const [before] = await countAll();
		await expect(create(input())).rejects.toBeInstanceOf(ProjectDatabaseError);
		const [after] = await countAll();
		expect(after).toEqual(before);
		await query(
			"drop trigger grove_test_fail_receipt on grove_command_receipts; drop function grove_test_fail_receipt() ",
		);
	});

	it("plans, derives readiness, fences exclusive Attempts, and publishes exact immutable output", async () => {
		const project = await create(input());
		const request = principalEvent();
		const run = <A, E>(effect: Effect.Effect<A, E, SvelteKitRequestEvent | ProjectService>) =>
			runtime.runPromise(effect.pipe(Effect.provideService(SvelteKitRequestEvent, request)));
		const contract = { requiredOutputs: ["artifact"] as const, reviewRequired: true as const };
		const planInput = {
			commandId: randomUUID(),
			projectId: project.objectId,
			expectedVersionId: project.versionId,
			tasks: [
				{
					key: "foundation",
					title: "Foundation",
					objective: "Prepare inputs",
					completionContract: contract,
				},
				{
					key: "build",
					title: "Build",
					objective: "Produce output",
					completionContract: contract,
				},
				{
					key: "independent",
					title: "Independent",
					objective: "Work in parallel",
					completionContract: contract,
				},
			],
			dependencies: [{ task: "build", dependsOn: "foundation" }],
		};
		const plan = await run(Effect.flatMap(ProjectService, (service) => service.plan(planInput)));
		const plannedRows = await query<{
			object_id: string;
			current_version_id: string;
			parent_task_id: string;
			parent_version_id: string | null;
			status: string;
		}>(`select o.id object_id,o.current_version_id,t.parent_task_id,v.parent_version_id,t.status
			from grove_objects o join grove_tasks t on t.object_id=o.id
			join grove_object_versions v on v.id=o.current_version_id
			where t.parent_task_id='${project.objectId}' order by o.id`);
		expect(plannedRows).toHaveLength(3);
		expect(plannedRows.map(({ object_id }) => object_id)).toEqual(
			Object.values(plan.taskIds).toSorted(),
		);
		expect(
			plannedRows.every(
				({ parent_task_id, parent_version_id, status }) =>
					parent_task_id === project.objectId && parent_version_id === null && status === "planned",
			),
		).toBe(true);
		expect(
			await query(
				`select 1 from grove_task_dependencies where task_id='${plan.taskIds.build}' and depends_on_task_id='${plan.taskIds.foundation}'`,
			),
		).toHaveLength(1);
		expect(
			await query<{ parent_version_id: string; status: string }>(
				`select v.parent_version_id,t.status from grove_objects o join grove_object_versions v on v.id=o.current_version_id join grove_tasks t on t.object_id=o.id where o.id='${project.objectId}'`,
			),
		).toEqual([{ parent_version_id: project.versionId, status: "planned" }]);
		expect(
			await query(`select 1 from grove_command_receipts where command_id='${plan.commandId}'`),
		).toHaveLength(1);
		expect(
			await query(`select 1 from grove_outbox where command_id='${plan.commandId}'`),
		).toHaveLength(4);
		const claimWriteCounts = () =>
			query<{ attempts: number; claims: number; receipts: number; events: number }>(`select
				(select count(*)::int from grove_attempts) attempts,
				(select count(*)::int from grove_claims) claims,
				(select count(*)::int from grove_command_receipts) receipts,
				(select count(*)::int from grove_outbox) events`);
		const [beforeProjectClaim] = await claimWriteCounts();
		await expect(
			run(
				Effect.flatMap(ProjectService, (service) =>
					service.claim({
						commandId: randomUUID(),
						taskId: project.objectId,
						leaseSeconds: 30,
					}),
				),
			),
		).rejects.toBeInstanceOf(CommandConflict);
		expect((await claimWriteCounts())[0]).toEqual(beforeProjectClaim);
		expect(
			(await run(Effect.flatMap(ProjectService, (service) => service.plan(planInput)))).replayed,
		).toBe(true);
		expect(
			await query(`select 1 from grove_command_receipts where command_id='${plan.commandId}'`),
		).toHaveLength(1);
		expect(
			await query(`select 1 from grove_outbox where command_id='${plan.commandId}'`),
		).toHaveLength(4);
		await expect(
			run(
				Effect.flatMap(ProjectService, (service) =>
					service.plan({
						...planInput,
						commandId: randomUUID(),
						expectedVersionId: plan.versionId,
					}),
				),
			),
		).rejects.toBeInstanceOf(CommandConflict);
		const countAll = () =>
			query<{
				objects: number;
				versions: number;
				tasks: number;
				dependencies: number;
				receipts: number;
				events: number;
			}>(`select
			(select count(*)::int from grove_objects) objects,
			(select count(*)::int from grove_object_versions) versions,
			(select count(*)::int from grove_tasks) tasks,
			(select count(*)::int from grove_task_dependencies) dependencies,
			(select count(*)::int from grove_command_receipts) receipts,
			(select count(*)::int from grove_outbox) events`);
		const [before] = await countAll();
		await expect(
			run(
				Effect.flatMap(ProjectService, (service) =>
					service.plan({
						...planInput,
						commandId: randomUUID(),
						expectedVersionId: plan.versionId,
						dependencies: [{ task: "build", dependsOn: "missing" }],
					}),
				),
			),
		).rejects.toBeInstanceOf(CommandConflict);
		await expect(
			run(
				Effect.flatMap(ProjectService, (service) =>
					service.plan({
						...planInput,
						commandId: randomUUID(),
						expectedVersionId: plan.versionId,
						dependencies: [
							{ task: "build", dependsOn: "independent" },
							{ task: "independent", dependsOn: "build" },
						],
					}),
				),
			),
		).rejects.toBeInstanceOf(CommandConflict);
		expect((await countAll())[0]).toEqual(before);
		const unplanned = await create(input());
		const [beforeStale] = await countAll();
		await expect(
			run(
				Effect.flatMap(ProjectService, (service) =>
					service.plan({
						...planInput,
						commandId: randomUUID(),
						projectId: unplanned.objectId,
						expectedVersionId: randomUUID(),
					}),
				),
			),
		).rejects.toMatchObject({ _tag: "CommandConflict", message: "Stale expected project version" });
		expect((await countAll())[0]).toEqual(beforeStale);
		const duplicateEdgeProject = await create(input());
		const [beforeDuplicateEdge] = await countAll();
		await expect(
			run(
				Effect.flatMap(ProjectService, (service) =>
					service.plan({
						...planInput,
						commandId: randomUUID(),
						projectId: duplicateEdgeProject.objectId,
						expectedVersionId: duplicateEdgeProject.versionId,
						dependencies: [
							{ task: "build", dependsOn: "foundation" },
							{ task: "build", dependsOn: "foundation" },
						],
					}),
				),
			),
		).rejects.toMatchObject({
			_tag: "CommandConflict",
			message: "Dependency edges must be unique",
		});
		expect((await countAll())[0]).toEqual(beforeDuplicateEdge);
		const prototypeKeyProject = await create(input());
		const prototypeKeyPlan = await run(
			Effect.flatMap(ProjectService, (service) =>
				service.plan({
					commandId: randomUUID(),
					projectId: prototypeKeyProject.objectId,
					expectedVersionId: prototypeKeyProject.versionId,
					tasks: [
						{
							key: "__proto__",
							title: "Prototype-safe task",
							objective: "Keep local keys opaque",
							completionContract: contract,
						},
					],
					dependencies: [],
				}),
			),
		);
		expect(Object.hasOwn(prototypeKeyPlan.taskIds, "__proto__")).toBe(true);
		expect(prototypeKeyPlan.taskIds.__proto__).toMatch(/^[\da-f-]{36}$/);
		const ready = await run(
			Effect.flatMap(ProjectService, (service) => service.ready({ projectId: project.objectId })),
		);
		expect(ready.map(({ taskId }) => taskId)).toEqual(
			[plan.taskIds.foundation, plan.taskIds.independent].toSorted(),
		);
		expect(ready).toEqual(
			[
				{ taskId: plan.taskIds.foundation, title: "Foundation", dependencyTaskIds: [] },
				{ taskId: plan.taskIds.independent, title: "Independent", dependencyTaskIds: [] },
			].toSorted((a, b) => a.taskId.localeCompare(b.taskId)),
		);
		const foundationClaim = await run(
			Effect.flatMap(ProjectService, (service) =>
				service.claim({
					commandId: randomUUID(),
					taskId: plan.taskIds.foundation,
					leaseSeconds: 30,
				}),
			),
		);
		const foundationOutput = await run(
			Effect.flatMap(ProjectService, (service) =>
				service.publish({
					commandId: randomUUID(),
					claimId: foundationClaim.claimId,
					fence: foundationClaim.fence,
					attemptId: foundationClaim.attemptId,
					title: "Foundation result",
					content: "Dependency complete",
				}),
			),
		);
		await runtime.runPromise(
			Effect.flatMap(ProjectService, (service) =>
				service.review({
					commandId: randomUUID(),
					taskId: plan.taskIds.foundation,
					attemptId: foundationClaim.attemptId,
					objectId: foundationOutput.objectId,
					versionId: foundationOutput.versionId,
					outcome: "accepted",
				}),
			).pipe(Effect.provideService(SvelteKitRequestEvent, principalEvent("foundation-reviewer"))),
		);
		const [foundationHead] = await query<{ current_version_id: string }>(
			`select current_version_id from grove_objects where id='${plan.taskIds.foundation}'`,
		);
		await run(
			Effect.flatMap(ProjectService, (service) =>
				service.complete({
					commandId: randomUUID(),
					taskId: plan.taskIds.foundation,
					expectedVersionId: foundationHead.current_version_id,
				}),
			),
		);
		const readyAfterDependency = await run(
			Effect.flatMap(ProjectService, (service) => service.ready({ projectId: project.objectId })),
		);
		expect(readyAfterDependency.map(({ taskId }) => taskId)).toEqual([
			plan.taskIds.independent,
			plan.taskIds.build,
		]);
		expect(
			readyAfterDependency.find(({ taskId }) => taskId === plan.taskIds.build)?.dependencyTaskIds,
		).toEqual([plan.taskIds.foundation]);

		const claimCommand = { commandId: randomUUID(), taskId: plan.taskIds.build, leaseSeconds: 30 };
		const claims = await Promise.allSettled([
			run(Effect.flatMap(ProjectService, (service) => service.claim(claimCommand))),
			run(
				Effect.flatMap(ProjectService, (service) =>
					service.claim({ ...claimCommand, commandId: randomUUID() }),
				),
			),
		]);
		expect(claims.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
		const rejectedClaim = claims.find(({ status }) => status === "rejected");
		expect(rejectedClaim?.status === "rejected" && rejectedClaim.reason).toBeInstanceOf(
			CommandConflict,
		);
		const successful = claims.find(({ status }) => status === "fulfilled");
		if (successful?.status !== "fulfilled") throw new Error("claim did not succeed");
		const claim = successful.value;
		const winningClaimInput =
			claim.commandId === claimCommand.commandId
				? claimCommand
				: { ...claimCommand, commandId: claim.commandId };
		expect(await query(`select 1 from grove_attempts where id='${claim.attemptId}'`)).toHaveLength(
			1,
		);
		expect(await query(`select 1 from grove_claims where id='${claim.claimId}'`)).toHaveLength(1);
		expect(
			await query(`select 1 from grove_command_receipts where command_id='${claim.commandId}'`),
		).toHaveLength(1);
		expect(
			await query(
				`select 1 from grove_outbox where command_id='${claim.commandId}' and event_type='task.claimed'`,
			),
		).toHaveLength(1);
		expect(
			await run(Effect.flatMap(ProjectService, (service) => service.claim(winningClaimInput))),
		).toEqual({ ...claim, replayed: true });
		await expect(
			run(
				Effect.flatMap(ProjectService, (service) =>
					service.renew({
						commandId: randomUUID(),
						claimId: claim.claimId,
						fence: "stale",
						leaseSeconds: 30,
					}),
				),
			),
		).rejects.toBeInstanceOf(FenceConflict);
		const renewInput = {
			commandId: randomUUID(),
			claimId: claim.claimId,
			fence: claim.fence,
			leaseSeconds: 30,
		};
		const renewed = await run(
			Effect.flatMap(ProjectService, (service) => service.renew(renewInput)),
		);
		expect(renewed.expiresAt).not.toBeNull();
		expect(
			await run(Effect.flatMap(ProjectService, (service) => service.renew(renewInput))),
		).toEqual({ ...renewed, replayed: true });
		expect(
			await query(
				`select 1 from grove_command_receipts where command_id='${renewInput.commandId}'`,
			),
		).toHaveLength(1);
		expect(
			await query(`select 1 from grove_outbox where command_id='${renewInput.commandId}'`),
		).toHaveLength(1);
		const publishInput = {
			commandId: randomUUID(),
			claimId: claim.claimId,
			fence: claim.fence,
			attemptId: claim.attemptId,
			title: "Result",
			content: "Immutable bytes",
		};
		const published = await run(
			Effect.flatMap(ProjectService, (service) => service.publish(publishInput)),
		);
		expect(
			await run(Effect.flatMap(ProjectService, (service) => service.publish(publishInput))),
		).toEqual({ ...published, replayed: true });
		expect(
			await query(
				`select 1 from grove_objects where id='${published.objectId}' and kind='artifact'`,
			),
		).toHaveLength(1);
		expect(
			await query(`select 1 from grove_object_versions where object_id='${published.objectId}'`),
		).toHaveLength(1);
		expect(
			await query(
				`select 1 from grove_attempt_outputs where attempt_id='${claim.attemptId}' and task_id='${plan.taskIds.build}' and object_id='${published.objectId}' and version_id='${published.versionId}'`,
			),
		).toHaveLength(1);
		expect(
			await query(
				`select 1 from grove_command_receipts where command_id='${publishInput.commandId}'`,
			),
		).toHaveLength(1);
		expect(
			await query(
				`select 1 from grove_outbox where command_id='${publishInput.commandId}' and event_type='attempt.output_published'`,
			),
		).toHaveLength(1);
		const [beforeRepublish] = await countAll();
		await expect(
			run(
				Effect.flatMap(ProjectService, (service) =>
					service.publish({
						...publishInput,
						commandId: randomUUID(),
					}),
				),
			),
		).rejects.toBeInstanceOf(CommandConflict);
		expect((await countAll())[0]).toEqual(beforeRepublish);
		const output = await query<{
			status: string;
			task_status: string;
			payload: Record<string, string>;
		}>(
			`select a.status,t.status task_status,v.payload from grove_attempts a join grove_tasks t on t.object_id=a.task_id join grove_attempt_outputs x on x.attempt_id=a.id join grove_object_versions v on v.id=x.version_id where a.id='${claim.attemptId}' and x.object_id='${published.objectId}'`,
		);
		expect(output[0]).toMatchObject({
			status: "result_submitted",
			task_status: "planned",
		});
		expect(output[0].payload).toMatchObject({
			taskId: plan.taskIds.build,
			attemptId: claim.attemptId,
		});
		expect(
			await query<{ completion_contract: typeof contract }>(
				`select v.payload->'completionContract' completion_contract from grove_objects o join grove_object_versions v on v.id=o.current_version_id where o.id='${plan.taskIds.build}'`,
			),
		).toEqual([{ completion_contract: contract }]);
		await expect(
			query(`update grove_object_versions set payload='{}' where id='${published.versionId}'`),
		).rejects.toBeDefined();
		const releaseInput = { commandId: randomUUID(), claimId: claim.claimId, fence: claim.fence };
		const released = await run(
			Effect.flatMap(ProjectService, (service) => service.release(releaseInput)),
		);
		expect(
			await run(Effect.flatMap(ProjectService, (service) => service.release(releaseInput))),
		).toEqual({ ...released, replayed: true });
		expect(
			await query(
				`select 1 from grove_command_receipts where command_id='${releaseInput.commandId}'`,
			),
		).toHaveLength(1);
		expect(
			await query(`select 1 from grove_outbox where command_id='${releaseInput.commandId}'`),
		).toHaveLength(1);
		await expect(
			run(
				Effect.flatMap(ProjectService, (service) =>
					service.release({ commandId: randomUUID(), claimId: claim.claimId, fence: claim.fence }),
				),
			),
		).rejects.toBeInstanceOf(FenceConflict);
		const next = await run(
			Effect.flatMap(ProjectService, (service) =>
				service.claim({ ...claimCommand, commandId: randomUUID() }),
			),
		);
		expect(next.attemptId).not.toBe(claim.attemptId);
		await expect(
			runtime.runPromise(
				Effect.flatMap(ProjectService, (service) =>
					service.review({
						commandId: randomUUID(),
						taskId: plan.taskIds.build,
						attemptId: claim.attemptId,
						objectId: published.objectId,
						versionId: published.versionId,
						outcome: "accepted",
					}),
				).pipe(Effect.provideService(SvelteKitRequestEvent, principalEvent("late-reviewer"))),
			),
		).rejects.toMatchObject({
			_tag: "CommandConflict",
			message: "A newer Attempt is already active",
		});
		expect(
			await query<{ status: string }>(
				`select status from grove_attempts where id='${claim.attemptId}'`,
			),
		).toEqual([{ status: "result_submitted" }]);
		await query(
			`update grove_claims set issued_at=now()-interval '2 seconds', expires_at=now()-interval '1 second' where id='${next.claimId}'`,
		);
		await expect(
			run(
				Effect.flatMap(ProjectService, (service) =>
					service.renew({
						commandId: randomUUID(),
						claimId: next.claimId,
						fence: next.fence,
						leaseSeconds: 30,
					}),
				),
			),
		).rejects.toBeInstanceOf(FenceConflict);
		expect(
			await query<{ claim_status: string; attempt_status: string }>(
				`select c.status claim_status,a.status attempt_status from grove_claims c join grove_attempts a on a.id=c.attempt_id where c.id='${next.claimId}'`,
			),
		).toEqual([{ claim_status: "expired", attempt_status: "fenced" }]);
		const afterExpiry = await run(
			Effect.flatMap(ProjectService, (service) =>
				service.claim({ ...claimCommand, commandId: randomUUID() }),
			),
		);
		expect(afterExpiry.attemptId).not.toBe(next.attemptId);
		expect(
			await query<{ status: string }>(
				`select status from grove_attempts where id='${next.attemptId}'`,
			),
		).toEqual([{ status: "fenced" }]);
		const otherRequest = principalEvent("other-holder");
		await expect(
			runtime.runPromise(
				Effect.flatMap(ProjectService, (service) =>
					service.release({
						commandId: randomUUID(),
						claimId: afterExpiry.claimId,
						fence: afterExpiry.fence,
					}),
				).pipe(Effect.provideService(SvelteKitRequestEvent, otherRequest)),
			),
		).rejects.toBeInstanceOf(FenceConflict);

		const publishCounts = () =>
			query<{
				objects: number;
				versions: number;
				outputs: number;
				receipts: number;
				events: number;
			}>(`select
			(select count(*)::int from grove_objects) objects,
			(select count(*)::int from grove_object_versions) versions,
			(select count(*)::int from grove_attempt_outputs) outputs,
			(select count(*)::int from grove_command_receipts) receipts,
			(select count(*)::int from grove_outbox) events`);
		const rejectPublishWithoutWrites = async (
			candidate: typeof publishInput,
			requestEvent = request,
		) => {
			const [beforePublish] = await publishCounts();
			await expect(
				runtime.runPromise(
					Effect.flatMap(ProjectService, (service) => service.publish(candidate)).pipe(
						Effect.provideService(SvelteKitRequestEvent, requestEvent),
					),
				),
			).rejects.toBeInstanceOf(FenceConflict);
			expect((await publishCounts())[0]).toEqual(beforePublish);
		};
		const activePublish = {
			...publishInput,
			commandId: randomUUID(),
			claimId: afterExpiry.claimId,
			fence: afterExpiry.fence,
			attemptId: afterExpiry.attemptId,
		};
		await rejectPublishWithoutWrites({ ...activePublish, commandId: randomUUID(), fence: "wrong" });
		await rejectPublishWithoutWrites({ ...activePublish, commandId: randomUUID() }, otherRequest);
		// The original claim is both released and a genuinely stale prior lease for this task.
		await rejectPublishWithoutWrites({ ...publishInput, commandId: randomUUID() });
		await query(
			`update grove_claims set issued_at=now()-interval '2 seconds', expires_at=now()-interval '1 second' where id='${afterExpiry.claimId}'`,
		);
		await rejectPublishWithoutWrites({ ...activePublish, commandId: randomUUID() });
	});

	it("uses live lease time after PostgreSQL lock waits and fences mutations at the boundary", async () => {
		const request = principalEvent();
		const run = <A, E>(effect: Effect.Effect<A, E, SvelteKitRequestEvent | ProjectService>) =>
			runtime.runPromise(effect.pipe(Effect.provideService(SvelteKitRequestEvent, request)));
		const freshTask = async () => {
			const project = await create(input());
			const plan = await run(
				Effect.flatMap(ProjectService, (service) =>
					service.plan({
						commandId: randomUUID(),
						projectId: project.objectId,
						expectedVersionId: project.versionId,
						tasks: [
							{
								key: "work",
								title: "Boundary work",
								objective: "Exercise lock timing",
								completionContract: { requiredOutputs: ["artifact"], reviewRequired: true },
							},
						],
						dependencies: [],
					}),
				),
			);
			return plan.taskIds.work;
		};
		const holdTransactionLock = (
			lock: (sql: PgClient.PgClient) => Effect.Effect<unknown, unknown>,
		) => {
			let signalAcquired!: () => void;
			let release!: () => void;
			const acquired = new Promise<void>((resolve) => (signalAcquired = resolve));
			const held = new Promise<void>((resolve) => (release = resolve));
			const transaction = runtime.runPromise(
				Effect.flatMap(PgClient.PgClient, (sql) =>
					sql.withTransaction(
						Effect.gen(function* () {
							yield* lock(sql);
							signalAcquired();
							yield* Effect.promise(() => held);
						}),
					),
				),
			);
			return { acquired, release, transaction };
		};
		const waitForLockWaiter = async (queryFragment: string) => {
			const deadline = Date.now() + 5_000;
			const poll = async (): Promise<void> => {
				const rows = await query<{ waiting: boolean }>(
					`select exists(select 1 from pg_stat_activity where state='active' and wait_event_type='Lock' and position('${queryFragment}' in query)>0) waiting`,
				);
				if (rows[0].waiting) return;
				if (Date.now() >= deadline)
					throw new Error(`Timed out waiting for blocked PostgreSQL query: ${queryFragment}`);
				await delay(20);
				return poll();
			};
			return poll();
		};
		const databaseTime = async () => {
			const rows = await query<{ value: string }>("select clock_timestamp()::text value");
			return new Date(rows[0].value).getTime();
		};

		const claimTaskId = await freshTask();
		const advisory = holdTransactionLock((sql) =>
			sql.unsafe("select pg_advisory_xact_lock(hashtextextended($1,1))", [claimTaskId]),
		);
		await advisory.acquired;
		const pendingClaim = run(
			Effect.flatMap(ProjectService, (service) =>
				service.claim({ commandId: randomUUID(), taskId: claimTaskId, leaseSeconds: 1 }),
			),
		);
		let claimReleaseTime: number;
		try {
			await waitForLockWaiter("pg_advisory_xact_lock(hashtextextended($1,1))");
			await delay(1_200);
			claimReleaseTime = await databaseTime();
		} finally {
			advisory.release();
			await advisory.transaction;
		}
		const liveClaim = await pendingClaim;
		expect(new Date(liveClaim.expiresAt).getTime() - claimReleaseTime).toBeGreaterThan(900);

		const renewalTaskId = await freshTask();
		const renewalClaim = await run(
			Effect.flatMap(ProjectService, (service) =>
				service.claim({ commandId: randomUUID(), taskId: renewalTaskId, leaseSeconds: 30 }),
			),
		);
		const renewalLock = holdTransactionLock((sql) =>
			sql.unsafe(
				"select c.id from grove_claims c join grove_attempts a on a.id=c.attempt_id where c.id=$1 for update of c,a",
				[renewalClaim.claimId],
			),
		);
		await renewalLock.acquired;
		const pendingRenewal = run(
			Effect.flatMap(ProjectService, (service) =>
				service.renew({
					commandId: randomUUID(),
					claimId: renewalClaim.claimId,
					fence: renewalClaim.fence,
					leaseSeconds: 1,
				}),
			),
		);
		let renewalReleaseTime: number;
		try {
			await waitForLockWaiter("select attempt_id,task_id,expires_at::text");
			await delay(1_200);
			renewalReleaseTime = await databaseTime();
		} finally {
			renewalLock.release();
			await renewalLock.transaction;
		}
		const liveRenewal = await pendingRenewal;
		if (liveRenewal.expiresAt === null) throw new Error("renewal did not return an expiry");
		expect(new Date(liveRenewal.expiresAt).getTime() - renewalReleaseTime).toBeGreaterThan(900);

		const assertBoundaryFence = async (operation: "publish" | "renew") => {
			const taskId = await freshTask();
			const claim = await run(
				Effect.flatMap(ProjectService, (service) =>
					service.claim({ commandId: randomUUID(), taskId, leaseSeconds: 1 }),
				),
			);
			const rowLock = holdTransactionLock((sql) =>
				sql.unsafe(
					"select c.id from grove_claims c join grove_attempts a on a.id=c.attempt_id where c.id=$1 for update of c,a",
					[claim.claimId],
				),
			);
			await rowLock.acquired;
			const mutation =
				operation === "renew"
					? run(
							Effect.flatMap(ProjectService, (service) =>
								service.renew({
									commandId: randomUUID(),
									claimId: claim.claimId,
									fence: claim.fence,
									leaseSeconds: 30,
								}),
							),
						)
					: run(
							Effect.flatMap(ProjectService, (service) =>
								service.publish({
									commandId: randomUUID(),
									claimId: claim.claimId,
									fence: claim.fence,
									attemptId: claim.attemptId,
									title: "Too late",
									content: "Expired while waiting",
								}),
							),
						);
			try {
				await waitForLockWaiter("select attempt_id,task_id,expires_at::text");
				await delay(1_200);
			} finally {
				rowLock.release();
				await rowLock.transaction;
			}
			await expect(mutation).rejects.toBeInstanceOf(FenceConflict);
			expect(
				await query<{ claim_status: string; attempt_status: string }>(
					`select c.status claim_status,a.status attempt_status from grove_claims c join grove_attempts a on a.id=c.attempt_id where c.id='${claim.claimId}'`,
				),
			).toEqual([{ claim_status: "expired", attempt_status: "fenced" }]);
		};
		await assertBoundaryFence("publish");
		await assertBoundaryFence("renew");
	}, 30_000);
});
