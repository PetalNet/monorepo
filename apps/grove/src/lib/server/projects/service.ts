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
	TaskClaim,
	WorkReady,
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
					task_version_id: string;
					expires_at: string;
					status: string;
					fence: string;
					holder_id: string;
					holder_kind: string;
				}>(
					"select c.attempt_id,c.task_id,a.task_version_id,c.expires_at::text,c.status,c.fence,c.holder_id,c.holder_kind from grove_claims c join grove_attempts a on a.id=c.attempt_id and a.task_id=c.task_id where c.id=$1 for update of c,a",
					[claimId],
				);
				const claim = rows.at(0);
				if (!claim) return yield* Effect.fail(new FenceConflict("Unknown claim"));
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
				return claim;
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
									"select o.current_version_id version_id from grove_tasks t join grove_objects o on o.id=t.object_id where t.object_id=$1 and t.role='work' and t.parent_task_id is not null and t.status='planned' and not exists(select 1 from grove_task_dependencies d join grove_tasks dep on dep.object_id=d.depends_on_task_id where d.task_id=t.object_id and dep.status<>'completed') and not exists(select 1 from grove_claims c where c.task_id=t.object_id and c.status='leased')",
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
									"select a.status,exists(select 1 from grove_attempt_outputs x where x.attempt_id=a.id) has_output from grove_attempts a where a.id=$1 and a.task_id=$2 for update",
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
							"select t.object_id \"taskId\",v.payload->>'title' title,coalesce(array_agg(d.depends_on_task_id order by d.depends_on_task_id) filter(where d.depends_on_task_id is not null),'{}') \"dependencyTaskIds\" from grove_tasks t join grove_objects o on o.id=t.object_id join grove_object_versions v on v.id=o.current_version_id left join grove_task_dependencies d on d.task_id=t.object_id where t.parent_task_id=$1 and t.role='work' and t.status='planned' and not exists(select 1 from grove_task_dependencies x join grove_tasks dep on dep.object_id=x.depends_on_task_id where x.task_id=t.object_id and dep.status<>'completed') and not exists(select 1 from grove_claims c where c.task_id=t.object_id and c.status='leased') group by t.object_id,v.payload order by coalesce(array_length(array_agg(d.depends_on_task_id) filter(where d.depends_on_task_id is not null),1),0),t.object_id",
							[input.projectId],
						);
					}),
				),
		};
	}),
);
