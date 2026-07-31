import { randomBytes, randomUUID } from "node:crypto";

import * as PgClient from "@effect/sql-pg/PgClient";
import { SvelteKitRequestEvent } from "@petalnet/effect-sveltekit";
import { Context, Effect, Layer } from "effect";

import type {
	AttemptPublish,
	ClaimMutationReceipt,
	ClaimReceipt,
	ClaimRelease,
	ClaimRenew,
	ProjectCreate,
	ProjectCreateReceipt,
	ProjectPlan,
	ProjectPlanReceipt,
	PublishReceipt,
	ReadyTasks,
	ReviewReceipt,
	ReviewSubmit,
	TaskClaim,
	TaskComplete,
	TaskCompleteReceipt,
	WorkReady,
	LibrarySearch,
	LibrarySearchResults,
	LibraryGetVersion,
	LibraryVersion,
} from "../../projects/schema";
import { AuthenticationRequired, requireGrovePrincipal } from "../authorization";
import { canonicalDigest, canonicalJson } from "./canonical";

export class CommandConflict extends Error {
	readonly _tag = "CommandConflict";
}
export class FenceConflict extends Error {
	readonly _tag = "FenceConflict";
}
export class ProjectDatabaseError extends Error {
	readonly _tag = "ProjectDatabaseError";
	constructor(readonly cause: unknown) {
		super("The project database is unavailable", { cause });
	}
}
type ProjectError = AuthenticationRequired | CommandConflict | FenceConflict | ProjectDatabaseError;
type RequestEffect<A> = Effect.Effect<A, ProjectError, SvelteKitRequestEvent>;
export interface ProjectServiceShape {
	readonly create: (input: ProjectCreate) => RequestEffect<ProjectCreateReceipt>;
	readonly plan: (input: ProjectPlan) => RequestEffect<ProjectPlanReceipt>;
	readonly claim: (input: TaskClaim) => RequestEffect<ClaimReceipt>;
	readonly renew: (input: ClaimRenew) => RequestEffect<ClaimMutationReceipt>;
	readonly release: (input: ClaimRelease) => RequestEffect<ClaimMutationReceipt>;
	readonly publish: (input: AttemptPublish) => RequestEffect<PublishReceipt>;
	readonly ready: (input: WorkReady) => RequestEffect<ReadyTasks>;
	readonly review: (input: ReviewSubmit) => RequestEffect<ReviewReceipt>;
	readonly complete: (input: TaskComplete) => RequestEffect<TaskCompleteReceipt>;
	readonly search: (input: LibrarySearch) => RequestEffect<LibrarySearchResults>;
	readonly getVersion: (input: LibraryGetVersion) => RequestEffect<LibraryVersion>;
}
export class ProjectService extends Context.Service<ProjectService, ProjectServiceShape>()(
	"grove/ProjectService",
) {}
const unavailable = () => Effect.die("Project data is unavailable during build");
export const ProjectServiceBuildLayer = Layer.succeed(ProjectService, {
	create: unavailable,
	plan: unavailable,
	claim: unavailable,
	renew: unavailable,
	release: unavailable,
	publish: unavailable,
	ready: unavailable,
	review: unavailable,
	complete: unavailable,
	search: unavailable,
	getVersion: unavailable,
});

interface ReceiptRow {
	operation: string;
	principal_id: string;
	principal_kind: string;
	input_hash: string;
	response: Record<string, unknown>;
}
interface Principal {
	id: string;
	kind: "human" | "mcp";
}
class CommittedFenceConflict {
	constructor(readonly message: string) {}
}
const replay = (row: ReceiptRow): Record<string, unknown> => ({ ...row.response, replayed: true });

export const ProjectServiceLayer = Layer.effect(
	ProjectService,
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient;
		const execute = <A>(
			operation: string,
			input: { commandId: string },
			principal: Principal,
			work: (commandId: string) => Effect.Effect<A | CommittedFenceConflict, unknown>,
			hashPayload?: unknown,
		): Effect.Effect<A, unknown> => {
			const commandId = input.commandId.toLowerCase();
			const hashInput: Record<string, unknown> = { ...input };
			delete hashInput.commandId;
			const hash = canonicalDigest(hashPayload ?? hashInput);
			return sql
				.withTransaction(
					Effect.gen(function* () {
						yield* sql.unsafe("select pg_advisory_xact_lock(hashtextextended($1, 0))", [commandId]);
						const rows = yield* sql.unsafe<ReceiptRow>(
							"select operation, principal_id, principal_kind, input_hash, response from grove_command_receipts where command_id=$1",
							[commandId],
						);
						if (rows[0]) {
							const row = rows[0];
							if (
								row.operation !== operation ||
								row.principal_id !== principal.id ||
								row.principal_kind !== principal.kind ||
								row.input_hash !== hash
							)
								return yield* Effect.fail(
									new CommandConflict("Command ID was already used with different input"),
								);
							return replay(row) as A;
						}
						const result = yield* work(commandId);
						if (result instanceof CommittedFenceConflict) return result;
						const metadata = result as Record<string, unknown>;
						yield* sql.unsafe(
							"insert into grove_command_receipts(command_id,operation,principal_id,principal_kind,input_hash,object_id,version_id,version_digest,response) values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)",
							[
								commandId,
								operation,
								principal.id,
								principal.kind,
								hash,
								metadata.objectId ?? metadata.projectId ?? metadata.taskId ?? null,
								metadata.versionId ?? null,
								metadata.versionDigest ?? null,
								canonicalJson(result),
							],
						);
						return result;
					}).pipe(Effect.provideService(PgClient.PgClient, sql)),
				)
				.pipe(
					Effect.flatMap((result) =>
						result instanceof CommittedFenceConflict
							? Effect.fail(new FenceConflict(result.message))
							: Effect.succeed(result),
					),
				);
		};
		const guarded = <A>(effect: Effect.Effect<A, unknown, SvelteKitRequestEvent>) =>
			effect.pipe(
				Effect.mapError((error) =>
					error instanceof AuthenticationRequired ||
					error instanceof CommandConflict ||
					error instanceof FenceConflict
						? error
						: new ProjectDatabaseError(error),
				),
			);
		const event = (
			commandId: string,
			type: string,
			aggregateId: string,
			versionId: string,
			payload: unknown,
		) =>
			sql.unsafe(
				"insert into grove_outbox(id,command_id,version_id,event_type,aggregate_id,payload) values($1,$2,$3,$4,$5,$6::jsonb)",
				[randomUUID(), commandId, versionId, type, aggregateId, canonicalJson(payload)],
			);
		const validateClaim = (claimId: string, fence: string, principal: Principal) =>
			Effect.gen(function* () {
				const rows = yield* sql.unsafe<{
					attempt_id: string;
					task_id: string;
					expires_at: string;
					status: string;
					fence: string;
					holder_id: string;
					holder_kind: string;
				}>(
					"select attempt_id,task_id,expires_at::text,status,fence,holder_id,holder_kind from grove_claims where id=$1 for update",
					[claimId],
				);
				const claim = rows.at(0);
				if (!claim) return yield* Effect.fail(new FenceConflict("Unknown claim"));
				const attempts = yield* sql.unsafe<{ task_version_id: string }>(
					"select task_version_id from grove_attempts where id=$1 and task_id=$2 for update",
					[claim.attempt_id, claim.task_id],
				);
				const lockedClaim = { ...claim, task_version_id: attempts[0].task_version_id };
				const liveTime = yield* sql.unsafe<{ expired: boolean }>(
					"select $1::timestamptz <= clock_timestamp() expired",
					[claim.expires_at],
				);
				if (claim.status === "leased" && liveTime[0].expired) {
					yield* sql.unsafe("update grove_claims set status='expired' where id=$1", [claimId]);
					yield* sql.unsafe(
						"update grove_attempts set status='fenced' where id=$1 and status='running'",
						[claim.attempt_id],
					);
					return new CommittedFenceConflict("Claim expired");
				}
				if (claim.status === "expired") return new CommittedFenceConflict("Claim expired");
				if (
					claim.status !== "leased" ||
					claim.fence !== fence ||
					claim.holder_id !== principal.id ||
					claim.holder_kind !== principal.kind
				)
					return yield* Effect.fail(
						new FenceConflict(
							claim.status === "released"
								? "Claim released"
								: claim.fence !== fence
									? "Stale fence"
									: "Wrong claim holder",
						),
					);
				return lockedClaim;
			});
		return {
			create: (input) =>
				guarded(
					Effect.gen(function* () {
						const principal = yield* requireGrovePrincipal;
						return yield* execute(
							"project.create",
							input,
							principal,
							(commandId) =>
								Effect.gen(function* () {
									const objectId = randomUUID(),
										versionId = randomUUID();
									const payload = {
											task: input.ask,
											scope: input.scope,
											title: input.title,
											type: "project",
											role: "project",
										},
										digest = canonicalDigest(payload);
									yield* sql.unsafe(
										"insert into grove_objects(id,kind,scope) values($1,'task',$2)",
										[objectId, input.scope],
									);
									yield* sql.unsafe(
										"insert into grove_object_versions(id,object_id,payload,digest,actor_id,actor_kind) values($1,$2,$3::jsonb,$4,$5,$6)",
										[
											versionId,
											objectId,
											canonicalJson(payload),
											digest,
											principal.id,
											principal.kind,
										],
									);
									yield* sql.unsafe("update grove_objects set current_version_id=$2 where id=$1", [
										objectId,
										versionId,
									]);
									yield* sql.unsafe(
										"insert into grove_tasks(object_id,role,status) values($1,'project','planning')",
										[objectId],
									);
									const result = {
										commandId,
										objectId,
										versionId,
										versionDigest: digest,
										replayed: false,
									};
									yield* event(commandId, "project.created", objectId, versionId, result);
									return result;
								}),
							{ scope: input.scope, title: input.title, task: input.ask },
						);
					}),
				),
			plan: (input) =>
				guarded(
					Effect.gen(function* () {
						const principal = yield* requireGrovePrincipal;
						return yield* execute("project.plan", input, principal, (commandId) =>
							Effect.gen(function* () {
								if (new Set(input.tasks.map((t) => t.key)).size !== input.tasks.length)
									return yield* Effect.fail(new CommandConflict("Task keys must be unique"));
								const edgeKeys = input.dependencies.map(
									(edge) => `${edge.task}\u0000${edge.dependsOn}`,
								);
								if (new Set(edgeKeys).size !== edgeKeys.length)
									return yield* Effect.fail(new CommandConflict("Dependency edges must be unique"));
								const keys = new Set(input.tasks.map((t) => t.key));
								if (input.dependencies.some((e) => !keys.has(e.task) || !keys.has(e.dependsOn)))
									return yield* Effect.fail(
										new CommandConflict("Dependency references an unknown local task key"),
									);
								const visit = (key: string, path: Set<string>): boolean =>
									path.has(key) ||
									input.dependencies
										.filter((e) => e.task === key)
										.some((e) => visit(e.dependsOn, new Set([...path, key])));
								if (input.tasks.some((t) => visit(t.key, new Set())))
									return yield* Effect.fail(new CommandConflict("Task dependency cycle"));
								const projects = yield* sql.unsafe<{
									current_version_id: string;
									scope: string;
									payload: Record<string, unknown>;
								}>(
									"select o.current_version_id,o.scope,v.payload from grove_objects o join grove_tasks t on t.object_id=o.id join grove_object_versions v on v.id=o.current_version_id where o.id=$1 and t.role='project' and t.status='planning' for update",
									[input.projectId],
								);
								if (projects[0]?.current_version_id !== input.expectedVersionId)
									return yield* Effect.fail(new CommandConflict("Stale expected project version"));
								const taskIdMap = new Map<string, string>();
								for (const task of input.tasks) {
									const id = randomUUID(),
										version = randomUUID(),
										payload = {
											type: "task",
											role: "work",
											title: task.title,
											objective: task.objective,
											status: "planned",
											completionContract: task.completionContract,
										};
									taskIdMap.set(task.key, id);
									yield* sql.unsafe(
										"insert into grove_objects(id,kind,scope) values($1,'task',$2)",
										[id, projects[0].scope],
									);
									yield* sql.unsafe(
										"insert into grove_object_versions(id,object_id,payload,digest,actor_id,actor_kind) values($1,$2,$3::jsonb,$4,$5,$6)",
										[
											version,
											id,
											canonicalJson(payload),
											canonicalDigest(payload),
											principal.id,
											principal.kind,
										],
									);
									yield* sql.unsafe("update grove_objects set current_version_id=$2 where id=$1", [
										id,
										version,
									]);
									yield* sql.unsafe(
										"insert into grove_tasks(object_id,role,status,parent_task_id) values($1,'work',$2,$3)",
										[id, "planned", input.projectId],
									);
									yield* event(commandId, "task.created", id, version, {
										taskId: id,
										projectId: input.projectId,
									});
								}
								for (const edge of input.dependencies)
									yield* sql.unsafe(
										"insert into grove_task_dependencies(task_id,depends_on_task_id) values($1,$2)",
										[taskIdMap.get(edge.task), taskIdMap.get(edge.dependsOn)],
									);
								const taskIds = Object.fromEntries(taskIdMap);
								const versionId = randomUUID(),
									payload = {
										...projects[0].payload,
										plan: { taskIds, dependencies: input.dependencies },
									};
								yield* sql.unsafe(
									"insert into grove_object_versions(id,object_id,parent_version_id,payload,digest,actor_id,actor_kind) values($1,$2,$3,$4::jsonb,$5,$6,$7)",
									[
										versionId,
										input.projectId,
										input.expectedVersionId,
										canonicalJson(payload),
										canonicalDigest(payload),
										principal.id,
										principal.kind,
									],
								);
								yield* sql.unsafe("update grove_objects set current_version_id=$2 where id=$1", [
									input.projectId,
									versionId,
								]);
								yield* sql.unsafe("update grove_tasks set status='planned' where object_id=$1", [
									input.projectId,
								]);
								const result = {
									commandId,
									projectId: input.projectId,
									versionId,
									taskIds,
									replayed: false,
								};
								yield* event(commandId, "project.planned", input.projectId, versionId, result);
								return result;
							}),
						);
					}),
				),
			claim: (input) =>
				guarded(
					Effect.gen(function* () {
						const principal = yield* requireGrovePrincipal;
						return yield* execute("task.claim", input, principal, (commandId) =>
							Effect.gen(function* () {
								yield* sql.unsafe("select pg_advisory_xact_lock(hashtextextended($1,1))", [
									input.taskId,
								]);
								yield* sql.unsafe(
									"with expired as (update grove_claims set status='expired' where task_id=$1 and status='leased' and expires_at<=clock_timestamp() returning attempt_id) update grove_attempts a set status='fenced' from expired e where a.id=e.attempt_id and a.status='running'",
									[input.taskId],
								);
								const ready = yield* sql.unsafe<{ version_id: string }>(
									"select o.current_version_id version_id from grove_tasks t join grove_objects o on o.id=t.object_id where t.object_id=$1 and t.role='work' and t.parent_task_id is not null and t.status='planned' and not exists(select 1 from grove_task_dependencies d join grove_tasks dep on dep.object_id=d.depends_on_task_id where d.task_id=t.object_id and dep.status<>'completed') and not exists(select 1 from grove_claims c where c.task_id=t.object_id and c.status='leased') and not exists(select 1 from grove_attempts a where a.task_id=t.object_id and a.status='accepted')",
									[input.taskId],
								);
								if (!ready[0]) return yield* Effect.fail(new CommandConflict("Task is not ready"));
								const attemptId = randomUUID(),
									claimId = randomUUID(),
									fence = randomBytes(32).toString("base64url");
								yield* sql.unsafe(
									"insert into grove_attempts(id,task_id,task_version_id,status,executor_id,executor_kind) values($1,$2,$3,'running',$4,$5)",
									[attemptId, input.taskId, ready[0].version_id, principal.id, principal.kind],
								);
								const dates = yield* sql.unsafe<{ expires_at: string }>(
									"with live_time as materialized (select clock_timestamp() value) insert into grove_claims(id,task_id,attempt_id,fence,holder_id,holder_kind,status,issued_at,expires_at) select $1,$2,$3,$4,$5,$6,'leased',value,value+($7||' seconds')::interval from live_time returning expires_at::text",
									[
										claimId,
										input.taskId,
										attemptId,
										fence,
										principal.id,
										principal.kind,
										input.leaseSeconds,
									],
								);
								const result = {
									commandId,
									taskId: input.taskId,
									attemptId,
									claimId,
									fence,
									expiresAt: dates[0].expires_at,
									replayed: false,
								};
								yield* event(commandId, "task.claimed", input.taskId, ready[0].version_id, result);
								return result;
							}),
						);
					}),
				),
			renew: (input) =>
				guarded(
					Effect.gen(function* () {
						const principal = yield* requireGrovePrincipal;
						return yield* execute("claim.renew", input, principal, (commandId) =>
							Effect.gen(function* () {
								const claim = yield* validateClaim(input.claimId, input.fence, principal);
								if (claim instanceof CommittedFenceConflict) return claim;
								const rows = yield* sql.unsafe<{ expires_at: string }>(
									"with live_time as materialized (select clock_timestamp() value) update grove_claims set expires_at=live_time.value+($2||' seconds')::interval from live_time where id=$1 returning expires_at::text",
									[input.claimId, input.leaseSeconds],
								);
								const result = {
									commandId,
									claimId: input.claimId,
									expiresAt: rows[0].expires_at,
									releasedAt: null,
									replayed: false,
								};
								yield* event(
									commandId,
									"claim.renewed",
									claim.task_id,
									claim.task_version_id,
									result,
								);
								return result;
							}),
						);
					}),
				),
			release: (input) =>
				guarded(
					Effect.gen(function* () {
						const principal = yield* requireGrovePrincipal;
						return yield* execute("claim.release", input, principal, (commandId) =>
							Effect.gen(function* () {
								const claim = yield* validateClaim(input.claimId, input.fence, principal);
								if (claim instanceof CommittedFenceConflict) return claim;
								const rows = yield* sql.unsafe<{ released_at: string }>(
									"update grove_claims set status='released',released_at=clock_timestamp() where id=$1 returning released_at::text",
									[input.claimId],
								);
								yield* sql.unsafe(
									"update grove_attempts set status='fenced' where id=$1 and status='running'",
									[claim.attempt_id],
								);
								const result = {
									commandId,
									claimId: input.claimId,
									expiresAt: null,
									releasedAt: rows[0].released_at,
									replayed: false,
								};
								yield* event(
									commandId,
									"claim.released",
									claim.task_id,
									claim.task_version_id,
									result,
								);
								return result;
							}),
						);
					}),
				),
			publish: (input) =>
				guarded(
					Effect.gen(function* () {
						const principal = yield* requireGrovePrincipal;
						return yield* execute("attempt.publish", input, principal, (commandId) =>
							Effect.gen(function* () {
								const claim = yield* validateClaim(input.claimId, input.fence, principal);
								if (claim instanceof CommittedFenceConflict) return claim;
								if (claim.attempt_id !== input.attemptId)
									return yield* Effect.fail(
										new FenceConflict("Claim does not authorize this attempt"),
									);
								const attempts = yield* sql.unsafe<{ status: string; has_output: boolean }>(
									"select a.status,exists(select 1 from grove_attempt_outputs x where x.attempt_id=a.id) has_output from grove_attempts a join grove_tasks t on t.object_id=a.task_id and t.role='work' and t.status='planned' where a.id=$1 and a.task_id=$2 for update of a,t",
									[input.attemptId, claim.task_id],
								);
								if (attempts[0]?.status !== "running" || attempts[0].has_output)
									return yield* Effect.fail(
										new CommandConflict("Attempt no longer accepts output"),
									);
								const scope = yield* sql.unsafe<{ scope: string }>(
									"select scope from grove_objects where id=$1",
									[claim.task_id],
								);
								const objectId = randomUUID(),
									versionId = randomUUID(),
									payload = {
										type: "artifact",
										title: input.title,
										content: input.content,
										taskId: claim.task_id,
										attemptId: input.attemptId,
									},
									digest = canonicalDigest(payload);
								yield* sql.unsafe(
									"insert into grove_objects(id,kind,scope) values($1,'artifact',$2)",
									[objectId, scope[0].scope],
								);
								yield* sql.unsafe(
									"insert into grove_object_versions(id,object_id,payload,digest,actor_id,actor_kind) values($1,$2,$3::jsonb,$4,$5,$6)",
									[
										versionId,
										objectId,
										canonicalJson(payload),
										digest,
										principal.id,
										principal.kind,
									],
								);
								yield* sql.unsafe("update grove_objects set current_version_id=$2 where id=$1", [
									objectId,
									versionId,
								]);
								yield* sql.unsafe(
									"insert into grove_attempt_outputs(attempt_id,task_id,object_id,version_id) values($1,$2,$3,$4)",
									[input.attemptId, claim.task_id, objectId, versionId],
								);
								yield* sql.unsafe(
									"update grove_attempts set status='result_submitted',result_submitted_at=now() where id=$1",
									[input.attemptId],
								);
								const result = {
									commandId,
									attemptId: input.attemptId,
									taskId: claim.task_id,
									objectId,
									versionId,
									versionDigest: digest,
									replayed: false,
								};
								yield* event(commandId, "attempt.output_published", objectId, versionId, result);
								return result;
							}),
						);
					}),
				),
			review: (input) =>
				guarded(
					Effect.gen(function* () {
						const principal = yield* requireGrovePrincipal;
						return yield* execute("review.submit", input, principal, (commandId) =>
							Effect.gen(function* () {
								yield* sql.unsafe("select pg_advisory_xact_lock(hashtextextended($1,1))", [
									input.taskId,
								]);
								// Claim -> Attempt/output/artifact is the lifecycle row-lock order.
								yield* sql.unsafe(
									"select id from grove_claims where attempt_id=$1 and task_id=$2 for update",
									[input.attemptId, input.taskId],
								);
								const rows = yield* sql.unsafe<{
									status: string;
									author_id: string;
									author_kind: string;
									scope: string;
								}>(
									"select a.status,v.actor_id author_id,v.actor_kind author_kind,o.scope from grove_attempts a join grove_tasks t on t.object_id=a.task_id and t.role='work' and t.status='planned' join grove_attempt_outputs x on x.attempt_id=a.id and x.task_id=a.task_id join grove_objects o on o.id=x.object_id and o.kind='artifact' join grove_object_versions v on v.id=x.version_id and v.object_id=x.object_id where a.id=$1 and a.task_id=$2 and x.object_id=$3 and x.version_id=$4 and o.current_version_id=x.version_id for update of a,t,x,o",
									[input.attemptId, input.taskId, input.objectId, input.versionId],
								);
								const target = rows.at(0);
								if (target?.status !== "result_submitted")
									return yield* Effect.fail(
										new CommandConflict("Attempt output is stale or not reviewable"),
									);
								if (input.outcome === "accepted") {
									const competingClaims = yield* sql.unsafe<{ exists: boolean }>(
										"select exists(select 1 from grove_claims where task_id=$1 and attempt_id<>$2 and status='leased' and expires_at>clock_timestamp()) exists",
										[input.taskId, input.attemptId],
									);
									if (competingClaims[0].exists)
										return yield* Effect.fail(
											new CommandConflict("A newer Attempt is already active"),
										);
								}
								const executors = yield* sql.unsafe<{ executor_id: string; executor_kind: string }>(
									"select executor_id,executor_kind from grove_attempts where id=$1 and task_id=$2",
									[input.attemptId, input.taskId],
								);
								if (
									(target.author_id === principal.id && target.author_kind === principal.kind) ||
									(executors[0].executor_id === principal.id &&
										executors[0].executor_kind === principal.kind)
								)
									return yield* Effect.fail(
										new CommandConflict(
											"Artifact authors and attempt executors cannot self-review",
										),
									);
								const reviewId = randomUUID(),
									reviewVersionId = randomUUID();
								const payload = {
									type: "review",
									reviewer: principal,
									taskId: input.taskId,
									attemptId: input.attemptId,
									subject: { objectId: input.objectId, versionId: input.versionId },
									outcome: input.outcome,
									...(input.comments === undefined ? {} : { comments: input.comments }),
								};
								const digest = canonicalDigest(payload);
								yield* sql.unsafe(
									"insert into grove_objects(id,kind,scope) values($1,'review',$2)",
									[reviewId, target.scope],
								);
								yield* sql.unsafe(
									"insert into grove_object_versions(id,object_id,payload,digest,actor_id,actor_kind) values($1,$2,$3::jsonb,$4,$5,$6)",
									[
										reviewVersionId,
										reviewId,
										canonicalJson(payload),
										digest,
										principal.id,
										principal.kind,
									],
								);
								yield* sql.unsafe("update grove_objects set current_version_id=$2 where id=$1", [
									reviewId,
									reviewVersionId,
								]);
								yield* sql.unsafe(
									"insert into grove_reviews(object_id,version_id,reviewer_id,reviewer_kind,subject_object_id,subject_version_id,attempt_id,task_id,outcome,comments) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
									[
										reviewId,
										reviewVersionId,
										principal.id,
										principal.kind,
										input.objectId,
										input.versionId,
										input.attemptId,
										input.taskId,
										input.outcome,
										input.comments ?? null,
									],
								);
								yield* sql.unsafe("update grove_attempts set status=$2 where id=$1", [
									input.attemptId,
									input.outcome === "accepted" ? "accepted" : "review_rejected",
								]);
								yield* sql.unsafe(
									`with live_time as materialized (select clock_timestamp() value)
									 update grove_claims
									 set status=case when expires_at<=live_time.value then 'expired' else 'released' end,
									     released_at=case when expires_at>live_time.value then live_time.value end
									 from live_time where attempt_id=$1 and status='leased'`,
									[input.attemptId],
								);
								const result = {
									commandId,
									reviewId,
									reviewVersionId,
									reviewDigest: digest,
									taskId: input.taskId,
									attemptId: input.attemptId,
									outcome: input.outcome,
									replayed: false,
								};
								yield* event(commandId, "review.submitted", reviewId, reviewVersionId, result);
								return result;
							}),
						);
					}),
				),
			complete: (input) =>
				guarded(
					Effect.gen(function* () {
						const principal = yield* requireGrovePrincipal;
						return yield* execute("task.complete", input, principal, (commandId) =>
							Effect.gen(function* () {
								yield* sql.unsafe("select pg_advisory_xact_lock(hashtextextended($1,1))", [
									input.taskId,
								]);
								// Lock the accepted Attempt's Claim before any Attempt/output/object row.
								yield* sql.unsafe(
									"select c.id from grove_claims c join grove_attempts a on a.id=c.attempt_id and a.task_id=c.task_id where c.task_id=$1 and a.status='accepted' for update of c",
									[input.taskId],
								);
								const rows = yield* sql.unsafe<{
									current_version_id: string;
									payload: Record<string, unknown>;
									attempt_id: string;
									output_object_id: string;
									output_version_id: string;
									review_id: string;
									review_version_id: string;
								}>(
									`select o.current_version_id,v.payload,a.id attempt_id,
									 x.object_id output_object_id,x.version_id output_version_id,
									 r.object_id review_id,r.version_id review_version_id
									 from grove_tasks t
									 join grove_objects o on o.id=t.object_id
									 join grove_object_versions v on v.id=o.current_version_id
									 join grove_attempts a on a.task_id=t.object_id and a.status='accepted'
									   and a.task_version_id=$2
									 join grove_attempt_outputs x on x.attempt_id=a.id and x.task_id=a.task_id
									 join grove_objects artifact on artifact.id=x.object_id and artifact.kind='artifact'
									   and artifact.current_version_id=x.version_id
									 join grove_reviews r on r.attempt_id=a.id and r.task_id=a.task_id
									   and r.subject_object_id=x.object_id and r.subject_version_id=x.version_id
									   and r.outcome='accepted'
									 where t.object_id=$1 and o.current_version_id=$2
									 and t.role='work' and t.status='planned'
									 and v.payload->'completionContract' = '{"requiredOutputs":["artifact"],"reviewRequired":true}'::jsonb
									 for update of t,o,a,x,artifact`,
									[input.taskId, input.expectedVersionId],
								);
								const task = rows.at(0);
								if (task?.current_version_id !== input.expectedVersionId)
									return yield* Effect.fail(
										new CommandConflict("Stale or unsatisfied Task completion"),
									);
								const versionId = randomUUID();
								const payload = {
									...task.payload,
									status: "completed",
									completion: {
										attemptId: task.attempt_id,
										output: {
											objectId: task.output_object_id,
											versionId: task.output_version_id,
										},
										review: {
											objectId: task.review_id,
											versionId: task.review_version_id,
										},
									},
								};
								const digest = canonicalDigest(payload);
								yield* sql.unsafe(
									"insert into grove_object_versions(id,object_id,parent_version_id,payload,digest,actor_id,actor_kind) values($1,$2,$3,$4::jsonb,$5,$6,$7)",
									[
										versionId,
										input.taskId,
										input.expectedVersionId,
										canonicalJson(payload),
										digest,
										principal.id,
										principal.kind,
									],
								);
								yield* sql.unsafe(
									"insert into grove_task_completions(completion_version_id,task_id,task_version_id,attempt_id,output_object_id,output_version_id,review_object_id,review_version_id) values($1,$2,$3,$4,$5,$6,$7,$8)",
									[
										versionId,
										input.taskId,
										input.expectedVersionId,
										task.attempt_id,
										task.output_object_id,
										task.output_version_id,
										task.review_id,
										task.review_version_id,
									],
								);
								yield* sql.unsafe("update grove_objects set current_version_id=$2 where id=$1", [
									input.taskId,
									versionId,
								]);
								yield* sql.unsafe("update grove_tasks set status='completed' where object_id=$1", [
									input.taskId,
								]);
								const result = {
									commandId,
									taskId: input.taskId,
									objectId: input.taskId,
									versionId,
									versionDigest: digest,
									replayed: false,
								};
								yield* event(commandId, "task.completed", input.taskId, versionId, result);
								return result;
							}),
						);
					}),
				),
			search: (input) =>
				guarded(
					Effect.gen(function* () {
						yield* requireGrovePrincipal;
						return yield* sql.unsafe<LibrarySearchResults[number]>(
							`select x.object_id "objectId",x.version_id "versionId",v.payload->>'title' title,
						v.payload->>'content' content,v.digest,x.task_id "taskId",x.attempt_id "attemptId",
						r.object_id "reviewId",r.version_id "reviewVersionId",r.outcome "reviewOutcome",
						r.reviewer_id "reviewerId",r.reviewer_kind "reviewerKind"
						from grove_task_completions c
						join grove_attempt_outputs x on x.attempt_id=c.attempt_id and x.task_id=c.task_id and x.object_id=c.output_object_id and x.version_id=c.output_version_id
						join grove_attempts a on a.id=c.attempt_id and a.task_id=c.task_id and a.status='accepted'
						join grove_tasks t on t.object_id=x.task_id and t.role='work'
						join grove_tasks project on project.object_id=t.parent_task_id and project.role='project'
						join grove_object_versions task_version on task_version.id=c.completion_version_id and task_version.object_id=c.task_id
						join grove_object_versions v on v.id=x.version_id and v.object_id=x.object_id
						join grove_reviews r on r.attempt_id=x.attempt_id and r.task_id=x.task_id
						  and r.subject_object_id=x.object_id and r.subject_version_id=x.version_id
						  and r.outcome='accepted'
						where project.object_id=$1
						and task_version.payload->>'status'='completed'
						and task_version.payload#>>'{completion,attemptId}'=x.attempt_id
						and task_version.payload#>>'{completion,output,objectId}'=x.object_id
						and task_version.payload#>>'{completion,output,versionId}'=x.version_id
						and task_version.payload#>>'{completion,review,objectId}'=r.object_id
						and task_version.payload#>>'{completion,review,versionId}'=r.version_id
						and to_tsvector('english',coalesce(v.payload->>'title','')||' '||coalesce(v.payload->>'content',''))
						  @@ websearch_to_tsquery('english',$2)
						order by ts_rank_cd(to_tsvector('english',coalesce(v.payload->>'title','')||' '||coalesce(v.payload->>'content','')),websearch_to_tsquery('english',$2)) desc,x.object_id limit $3`,
							[input.projectId, input.query, input.limit ?? 20],
						);
					}),
				),
			getVersion: (input) =>
				guarded(
					Effect.gen(function* () {
						yield* requireGrovePrincipal;
						const rows = yield* sql.unsafe<LibraryVersion>(
							`select x.object_id "objectId",x.version_id "versionId",v.payload,v.digest,
						v.actor_id "authorId",v.actor_kind "authorKind",v.created_at::text "createdAt",
						x.task_id "taskId",x.attempt_id "attemptId",r.object_id "reviewId",
						r.version_id "reviewVersionId",r.outcome "reviewOutcome",
						r.reviewer_id "reviewerId",r.reviewer_kind "reviewerKind"
						from grove_task_completions c
						join grove_attempt_outputs x on x.attempt_id=c.attempt_id and x.task_id=c.task_id and x.object_id=c.output_object_id and x.version_id=c.output_version_id
						join grove_attempts a on a.id=c.attempt_id and a.task_id=c.task_id and a.status='accepted'
						join grove_object_versions v on v.id=x.version_id and v.object_id=x.object_id
						join grove_tasks t on t.object_id=x.task_id and t.role='work'
						join grove_tasks project on project.object_id=t.parent_task_id and project.role='project'
						join grove_object_versions task_version on task_version.id=c.completion_version_id and task_version.object_id=c.task_id
						join grove_reviews r on r.attempt_id=x.attempt_id and r.task_id=x.task_id
						  and r.subject_object_id=x.object_id and r.subject_version_id=x.version_id
						  and r.outcome='accepted'
						where project.object_id=$1 and x.object_id=$2 and x.version_id=$3
						and task_version.payload->>'status'='completed'
						and task_version.payload#>>'{completion,attemptId}'=x.attempt_id
						and task_version.payload#>>'{completion,output,objectId}'=x.object_id
						and task_version.payload#>>'{completion,output,versionId}'=x.version_id
						and task_version.payload#>>'{completion,review,objectId}'=r.object_id
						and task_version.payload#>>'{completion,review,versionId}'=r.version_id`,
							[input.projectId, input.objectId, input.versionId],
						);
						if (!rows[0])
							return yield* Effect.fail(new CommandConflict("Library Version is unavailable"));
						return rows[0];
					}),
				),
			ready: (input) =>
				guarded(
					Effect.gen(function* () {
						yield* requireGrovePrincipal;
						yield* sql.unsafe(
							"with expired as (update grove_claims set status='expired' where status='leased' and expires_at<=clock_timestamp() returning attempt_id) update grove_attempts a set status='fenced' from expired e where a.id=e.attempt_id and a.status='running'",
						);
						// MVP visibility is all authenticated principals within the supplied project.
						return yield* sql.unsafe<{
							taskId: string;
							title: string;
							dependencyTaskIds: string[];
						}>(
							"select t.object_id \"taskId\",v.payload->>'title' title,coalesce(array_agg(d.depends_on_task_id order by d.depends_on_task_id) filter(where d.depends_on_task_id is not null),'{}') \"dependencyTaskIds\" from grove_tasks t join grove_objects o on o.id=t.object_id join grove_object_versions v on v.id=o.current_version_id left join grove_task_dependencies d on d.task_id=t.object_id where t.parent_task_id=$1 and t.role='work' and t.status='planned' and not exists(select 1 from grove_task_dependencies x join grove_tasks dep on dep.object_id=x.depends_on_task_id where x.task_id=t.object_id and dep.status<>'completed') and not exists(select 1 from grove_claims c where c.task_id=t.object_id and c.status='leased') and not exists(select 1 from grove_attempts a where a.task_id=t.object_id and a.status='accepted') group by t.object_id,v.payload order by coalesce(array_length(array_agg(d.depends_on_task_id) filter(where d.depends_on_task_id is not null),1),0),t.object_id",
							[input.projectId],
						);
					}),
				),
		};
	}),
);
