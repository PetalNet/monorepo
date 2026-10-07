import * as PgClient from "@effect/sql-pg/PgClient";
import { Context, Data, Effect, Layer, Match, Schema } from "effect";
import { Cast, Fragment, Query, Table, Type } from "effect-qb";
import * as Pg from "effect-qb/postgres";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

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
import { ActorAuthority, ActorDenied, type AuthorityError } from "../actors/authority";
import {
	grove_objects as objects,
	grove_object_versions as versions,
	grove_outbox as outbox,
	grove_tasks as tasks,
	grove_attempts as attemptsTable,
	grove_claims as claims,
	grove_attempt_outputs as outputs,
	grove_task_dependencies as dependencies,
	grove_command_receipts as receipts,
} from "../db/tables";
import { InvocationContext } from "../invocation";
import { canonicalDigest } from "./canonical";

const Q = { ...Query, ...Pg.Query };
const responseSchema = Schema.Record(Schema.String, Schema.Unknown);
const nullableMetadata = Schema.decodeUnknownSync(Schema.NullOr(Schema.String));
// 0.24.1 propagates anti-join IS NULL refinements to unrelated projections.
// Keep that unsupported refinement opaque while retaining typed column interpolation.
const antiJoinAbsent = Fragment.expression({
	dbType: Type.boolean(),
	schema: Schema.Boolean,
	nullability: "never",
});

export class CommandConflict extends Data.TaggedError("CommandConflict")<{
	readonly message: string;
}> {}
export class FenceConflict extends Data.TaggedError("FenceConflict")<{
	readonly message: string;
}> {}
export class ProjectDatabaseError extends Data.TaggedError("ProjectDatabaseError")<{
	readonly cause: unknown;
}> {
	override get message() {
		return "The project database is unavailable";
	}
}
export type ProjectError = AuthorityError | CommandConflict | FenceConflict | ProjectDatabaseError;
type PersistenceError =
	| ProjectError
	| SqlError
	| Schema.SchemaError
	| Pg.Executor.PostgresExecutorError
	| Pg.Errors.PostgresQueryRequirementsError;
type RequestEffect<A> = Effect.Effect<A, ProjectError, InvocationContext>;
export interface ProjectServiceShape {
	readonly create: (input: ProjectCreate) => RequestEffect<ProjectCreateReceipt>;
	readonly plan: (input: ProjectPlan) => RequestEffect<ProjectPlanReceipt>;
	readonly claim: (input: TaskClaim) => RequestEffect<ClaimReceipt>;
	readonly renew: (input: ClaimRenew) => RequestEffect<ClaimMutationReceipt>;
	readonly release: (input: ClaimRelease) => RequestEffect<ClaimMutationReceipt>;
	readonly publish: (input: AttemptPublish) => RequestEffect<PublishReceipt>;
	readonly ready: (input: WorkReady) => RequestEffect<ReadyTasks>;
}
/** @effect-expect-leaking InvocationContext */
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
	// Historical persistence names remain stable; IDs identify enrolled Actors,
	// never browser accounts or external machine subjects.
	id: string;
	kind: "person" | "agent";
}

const requireProjectActor = Effect.flatMap(InvocationContext, ({ principal }) =>
	principal.kind === "person" || principal.kind === "agent"
		? Effect.succeed({ id: principal.actorId, kind: principal.kind })
		: Effect.fail(new ActorDenied({ reason: "An enrolled actor is required" })),
);

class CommittedConflict {
	constructor(readonly error: CommandConflict | FenceConflict) {}
}
const replay = (row: ReceiptRow): Record<string, unknown> => ({ ...row.response, replayed: true });

export const ProjectServiceLayer = Layer.effect(
	ProjectService,
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient;
		// Raw SQL below is restricted to PostgreSQL advisory locks, live-clock
		// lease operations, unsupported FOR UPDATE OF targets, and ordered JSON
		// readiness projections. Ordinary persistence uses canonical Q plans.
		const executor = Pg.Executor.make();
		const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
			effect.pipe(Effect.provideService(SqlClient.SqlClient, sql));
		const authority = yield* ActorAuthority;
		const authorize = (operation: string) =>
			Effect.flatMap(InvocationContext, ({ principal }) =>
				principal.kind === "person" || principal.kind === "agent"
					? authority.authorizeActor(principal, operation)
					: Effect.fail(new ActorDenied({ reason: "An enrolled actor is required" })),
			);
		const execute = <A>(
			operation: string,
			input: { commandId: string },
			principal: Principal,
			work: (commandId: string) => Effect.Effect<A | CommittedConflict, PersistenceError>,
			hashPayload?: unknown,
		): Effect.Effect<A, PersistenceError, InvocationContext> => {
			const commandId = input.commandId.toLowerCase();
			const hashInput: Record<string, unknown> = { ...input };

			delete hashInput.commandId;

			return sql
				.withTransaction(
					Effect.gen(function* () {
						const hash = yield* canonicalDigest(hashPayload ?? hashInput);

						// Replays need current capability/lifecycle checks too. Authority's
						// locks participate in this same PostgreSQL transaction.
						yield* authorize(operation);
						yield* sql.unsafe("select pg_advisory_xact_lock(hashtextextended($1, 0))", [commandId]);

						const rows = yield* run(
							executor.execute(
								Q.select({
									operation: receipts.operation,
									principal_id: receipts.principal_id,
									principal_kind: receipts.principal_kind,
									input_hash: receipts.input_hash,
									response: receipts.response,
								}).pipe(
									Q.from(receipts),
									Q.where(
										Q.eq(receipts.command_id, Q.literal(commandId).pipe(Cast.to(Type.uuid()))),
									),
								),
							),
						);

						if (rows[0]) {
							const row = rows[0];

							if (
								row.operation !== operation ||
								row.principal_id !== principal.id ||
								row.principal_kind !== principal.kind ||
								row.input_hash !== hash
							) {
								return yield* new CommandConflict({
									message: "Command ID was already used with different input",
								});
							}

							const response = yield* Schema.decodeUnknownEffect(responseSchema)(row.response);

							return replay({ ...row, response }) as A;
						}

						const result = yield* work(commandId);

						if (result instanceof CommittedConflict) {
							return result;
						}

						const metadata = result as Record<string, unknown>;

						yield* run(
							executor.execute(
								Q.insert(receipts, {
									command_id: commandId,
									operation,
									principal_id: principal.id,
									principal_kind: principal.kind,
									input_hash: hash,
									object_id: nullableMetadata(
										metadata.objectId ?? metadata.projectId ?? metadata.taskId ?? null,
									),
									version_id: nullableMetadata(metadata.versionId ?? null),
									version_digest: nullableMetadata(metadata.versionDigest ?? null),
									response: result,
								}),
							),
						);

						return result;
					}).pipe(Effect.provideService(PgClient.PgClient, sql)),
				)
				.pipe(
					// Fail only after the expiry recovery transaction commits. Moving
					// this inside withTransaction would resurrect the expired lease.
					// oxlint-disable-next-line effecttsgo/flat-map-conditional-to-filter-or-fail -- filterOrFail does not narrow its failure callback's generic result.
					Effect.flatMap((result) =>
						result instanceof CommittedConflict
							? Effect.fail(result.error)
							: Effect.succeed(result),
					),
				);
		};

		const guarded = <A>(
			effect: Effect.Effect<A, PersistenceError, InvocationContext>,
			readOperation?: string,
		) =>
			// Commands own their transaction in execute; wrapping them here would
			// roll back the committed-expiry sentinel on its eventual typed failure.
			(readOperation
				? sql.withTransaction(authorize(readOperation).pipe(Effect.andThen(effect)))
				: effect
			).pipe(
				Effect.mapError((error) =>
					Match.value(error).pipe(
						Match.tags({
							ActorDenied: (failure) => failure,
							ActorDatabaseError: (failure) => failure,
							ActorNotCurrent: (failure) => failure,
							HomeOwnerUnbound: (failure) => failure,
							CapabilityContainmentConflict: (failure) => failure,
							CommandConflict: (failure) => failure,
							FenceConflict: (failure) => failure,
							ProjectDatabaseError: (failure) => failure,
						}),
						Match.orElse((cause) => new ProjectDatabaseError({ cause })),
					),
				),
			);
		const event = (
			commandId: string,
			type: string,
			aggregateId: string,
			versionId: string,
			payload: unknown,
		) =>
			run(
				executor.execute(
					Q.insert(outbox, {
						id: crypto.randomUUID(),
						command_id: commandId,
						version_id: versionId,
						event_type: type,
						aggregate_id: aggregateId,
						payload,
					}),
				),
			);
		const pointVersion = (objectId: string, versionId: string) =>
			run(
				executor.execute(
					Q.update(objects, { current_version_id: versionId }).pipe(
						Q.where(Q.eq(objects.id, objectId)),
					),
				),
			);
		const fenceAttempt = (attemptId: string) =>
			run(
				executor.execute(
					Q.update(attemptsTable, { status: "fenced" }).pipe(
						Q.where(
							Q.and(Q.eq(attemptsTable.id, attemptId), Q.eq(attemptsTable.status, "running")),
						),
					),
				),
			);
		const insertVersion = (
			id: string,
			objectId: string,
			payload: unknown,
			digest: string,
			principal: Principal,
			parentVersionId: string | null = null,
		) =>
			run(
				executor.execute(
					Q.insert(versions, {
						id,
						object_id: objectId,
						payload,
						digest,
						actor_id: principal.id,
						actor_kind: principal.kind,
						parent_version_id: parentVersionId,
					}),
				),
			);
		const validateClaim = (claimId: string, fence: string, principal: Principal) =>
			Effect.gen(function* () {
				const rows = yield* run(
					executor.execute(
						Q.select({
							attempt_id: claims.attempt_id,
							task_id: claims.task_id,
							expires_at: claims.expires_at.pipe(Cast.to(Type.text())),
							status: claims.status,
							fence: claims.fence,
							holder_id: claims.holder_id,
							holder_kind: claims.holder_kind,
						}).pipe(Q.from(claims), Q.where(Q.eq(claims.id, claimId)), Q.lock("update")),
					),
				);
				const claim = rows.at(0);

				if (!claim) {
					return yield* new FenceConflict({ message: "Unknown claim" });
				}

				const attempts = yield* run(
					executor.execute(
						Q.select({ task_version_id: attemptsTable.task_version_id }).pipe(
							Q.from(attemptsTable),
							Q.where(
								Q.and(
									Q.eq(attemptsTable.id, claim.attempt_id),
									Q.eq(attemptsTable.task_id, claim.task_id),
								),
							),
							Q.lock("update"),
						),
					),
				);
				const lockedClaim = { ...claim, task_version_id: attempts[0].task_version_id };
				// Live PostgreSQL time, not the transaction-start timestamp.
				const liveTime = yield* sql.unsafe<{ expired: boolean }>(
					"select $1::timestamptz <= clock_timestamp() expired",
					[claim.expires_at],
				);

				if (claim.status === "leased" && liveTime[0].expired) {
					yield* run(
						executor.execute(
							Q.update(claims, { status: "expired" }).pipe(Q.where(Q.eq(claims.id, claimId))),
						),
					);

					yield* fenceAttempt(claim.attempt_id);

					return new CommittedConflict(new FenceConflict({ message: "Claim expired" }));
				}

				if (claim.status === "expired") {
					return new CommittedConflict(new FenceConflict({ message: "Claim expired" }));
				}

				if (
					claim.status !== "leased" ||
					claim.fence !== fence ||
					claim.holder_id !== principal.id ||
					claim.holder_kind !== principal.kind
				) {
					return yield* new FenceConflict({
						message:
							claim.status === "released"
								? "Claim released"
								: claim.fence === fence
									? "Wrong claim holder"
									: "Stale fence",
					});
				}

				return lockedClaim;
			});

		return {
			create: (input) =>
				guarded(
					Effect.gen(function* () {
						const principal = yield* requireProjectActor;

						return yield* execute(
							"project.create",
							input,
							principal,
							(commandId) =>
								Effect.gen(function* () {
									const objectId = crypto.randomUUID(),
										versionId = crypto.randomUUID();
									const payload = {
										task: input.ask,
										scope: input.scope,
										title: input.title,
										type: "project",
										role: "project",
									};
									const digest = yield* canonicalDigest(payload);

									yield* run(
										executor.execute(
											Q.insert(objects, { id: objectId, kind: "task", scope: input.scope }),
										),
									);

									yield* insertVersion(versionId, objectId, payload, digest, principal);
									yield* pointVersion(objectId, versionId);

									yield* run(
										executor.execute(
											Q.insert(tasks, { object_id: objectId, role: "project", status: "planning" }),
										),
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
						const principal = yield* requireProjectActor;

						return yield* execute("project.plan", input, principal, (commandId) =>
							Effect.gen(function* () {
								if (new Set(input.tasks.map((t) => t.key)).size !== input.tasks.length) {
									return yield* new CommandConflict({ message: "Task keys must be unique" });
								}

								const edgeKeys = input.dependencies.map(
									(edge) => `${edge.task}\u0000${edge.dependsOn}`,
								);

								if (new Set(edgeKeys).size !== edgeKeys.length) {
									return yield* new CommandConflict({ message: "Dependency edges must be unique" });
								}

								const keys = new Set(input.tasks.map((t) => t.key));

								if (input.dependencies.some((e) => !keys.has(e.task) || !keys.has(e.dependsOn))) {
									return yield* new CommandConflict({
										message: "Dependency references an unknown local task key",
									});
								}

								const visit = (key: string, path: Set<string>): boolean =>
									path.has(key) ||
									input.dependencies
										.filter((e) => e.task === key)
										.some((e) => visit(e.dependsOn, new Set([...path, key])));

								if (input.tasks.some((t) => visit(t.key, new Set()))) {
									return yield* new CommandConflict({ message: "Task dependency cycle" });
								}

								const projects = yield* run(
									executor.execute(
										Q.select({
											current_version_id: objects.current_version_id,
											scope: objects.scope,
											payload: versions.payload,
										}).pipe(
											Q.from(objects),
											Q.innerJoin(tasks, Q.eq(tasks.object_id, objects.id)),
											Q.innerJoin(versions, Q.eq(versions.id, objects.current_version_id)),
											Q.where(
												Q.and(
													Q.eq(objects.id, input.projectId),
													Q.eq(tasks.role, "project"),
													Q.eq(tasks.status, "planning"),
												),
											),
											Q.lock("update"),
										),
									),
								);

								if (projects[0]?.current_version_id !== input.expectedVersionId) {
									return yield* new CommandConflict({ message: "Stale expected project version" });
								}

								const taskIdMap = new Map<string, string>();

								for (const task of input.tasks) {
									const id = crypto.randomUUID(),
										version = crypto.randomUUID();
									const payload = {
										type: "task",
										role: "work",
										title: task.title,
										objective: task.objective,
										status: "planned",
										completionContract: task.completionContract,
									};

									taskIdMap.set(task.key, id);

									yield* run(
										executor.execute(
											Q.insert(objects, { id, kind: "task", scope: projects[0].scope }),
										),
									);

									yield* insertVersion(
										version,
										id,
										payload,
										yield* canonicalDigest(payload),
										principal,
									);

									yield* pointVersion(id, version);

									yield* run(
										executor.execute(
											Q.insert(tasks, {
												object_id: id,
												role: "work",
												status: "planned",
												parent_task_id: input.projectId,
											}),
										),
									);

									yield* event(commandId, "task.created", id, version, {
										taskId: id,
										projectId: input.projectId,
									});
								}

								const taskIdsFor = (key: string) => {
									const id = taskIdMap.get(key);

									if (id === undefined) {
										throw new Error("Validated dependency is missing its Task");
									}

									return id;
								};

								for (const edge of input.dependencies) {
									yield* run(
										executor.execute(
											Q.insert(dependencies, {
												task_id: taskIdsFor(edge.task),
												depends_on_task_id: taskIdsFor(edge.dependsOn),
											}),
										),
									);
								}

								const taskIds = Object.fromEntries(taskIdMap);
								const projectPayload = yield* Schema.decodeUnknownEffect(responseSchema)(
									projects[0].payload,
								);
								const versionId = crypto.randomUUID();
								const payload = {
									...projectPayload,
									plan: { taskIds, dependencies: input.dependencies },
								};

								yield* insertVersion(
									versionId,
									input.projectId,
									payload,
									yield* canonicalDigest(payload),
									principal,
									input.expectedVersionId,
								);

								yield* pointVersion(input.projectId, versionId);

								yield* run(
									executor.execute(
										Q.update(tasks, { status: "planned" }).pipe(
											Q.where(Q.eq(tasks.object_id, input.projectId)),
										),
									),
								);

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
						const principal = yield* requireProjectActor;

						return yield* execute("task.claim", input, principal, (commandId) =>
							Effect.gen(function* () {
								yield* sql.unsafe("select pg_advisory_xact_lock(hashtextextended($1,1))", [
									input.taskId,
								]);

								// Writable CTE reconciles expiry and fencing atomically using live time.
								yield* sql.unsafe(
									"with expired as (update grove_claims set status='expired' where task_id=$1 and status='leased' and expires_at<=clock_timestamp() returning attempt_id) update grove_attempts a set status='fenced' from expired e where a.id=e.attempt_id and a.status='running'",
									[input.taskId],
								);

								const dependencyTask = Table.alias(tasks, "dependency_task");
								// Anti-joins avoid 0.24.1's portable-only EXISTS contract without
								// duplicating canonical PostgreSQL table definitions.
								const blocked = Q.as(
									Q.select({ task_id: dependencies.task_id }).pipe(
										Q.from(dependencies),
										Q.innerJoin(
											dependencyTask,
											Q.eq(dependencyTask.object_id, dependencies.depends_on_task_id),
										),
										Q.where(Q.neq(dependencyTask.status, "completed")),
									),
									"blocked",
								);
								const ready = yield* run(
									executor.execute(
										Q.select({ version_id: versions.id }).pipe(
											Q.from(versions),
											Q.innerJoin(objects, Q.eq(versions.id, objects.current_version_id)),
											Q.innerJoin(tasks, Q.eq(objects.id, tasks.object_id)),
											Q.leftJoin(blocked, Q.eq(blocked.task_id, tasks.object_id)),
											Q.leftJoin(
												claims,
												Q.and(Q.eq(claims.task_id, tasks.object_id), Q.eq(claims.status, "leased")),
											),
											Q.where(
												Q.and(
													Q.eq(tasks.object_id, input.taskId),
													Q.eq(tasks.role, "work"),
													Q.isNotNull(tasks.parent_task_id),
													Q.eq(tasks.status, "planned"),
													antiJoinAbsent`${blocked.task_id} is null and ${claims.id} is null`,
												),
											),
										),
									),
								);

								// Expiry reconciliation remains committed even when readiness
								// prevents issuing a replacement Claim. No receipt is written.
								if (!ready[0]) {
									return new CommittedConflict(
										new CommandConflict({ message: "Task is not ready" }),
									);
								}

								const attemptId = crypto.randomUUID(),
									claimId = crypto.randomUUID(),
									fence = crypto
										.getRandomValues(new Uint8Array(32))
										.toBase64({ alphabet: "base64url", omitPadding: true });

								yield* run(
									executor.execute(
										Q.insert(attemptsTable, {
											id: attemptId,
											task_id: input.taskId,
											task_version_id: ready[0].version_id,
											status: "running",
											executor_id: principal.id,
											executor_kind: principal.kind,
										}),
									),
								);

								// Materialize one live instant for both lease endpoints.
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
						const principal = yield* requireProjectActor;

						return yield* execute("claim.renew", input, principal, (commandId) =>
							Effect.gen(function* () {
								const claim = yield* validateClaim(input.claimId, input.fence, principal);

								if (claim instanceof CommittedConflict) {
									return claim;
								}

								// Materialized live-clock CTE preserves lease timing after lock waits.
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
						const principal = yield* requireProjectActor;

						return yield* execute("claim.release", input, principal, (commandId) =>
							Effect.gen(function* () {
								const claim = yield* validateClaim(input.claimId, input.fence, principal);

								if (claim instanceof CommittedConflict) {
									return claim;
								}

								// Keep the live release instant and PostgreSQL's textual precision.
								const rows = yield* sql.unsafe<{ released_at: string }>(
									"update grove_claims set status='released',released_at=clock_timestamp() where id=$1 returning released_at::text",
									[input.claimId],
								);

								yield* fenceAttempt(claim.attempt_id);

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
						const principal = yield* requireProjectActor;

						return yield* execute("attempt.publish", input, principal, (commandId) =>
							Effect.gen(function* () {
								const claim = yield* validateClaim(input.claimId, input.fence, principal);

								if (claim instanceof CommittedConflict) {
									return claim;
								}

								if (claim.attempt_id !== input.attemptId) {
									return yield* new FenceConflict({
										message: "Claim does not authorize this attempt",
									});
								}

								// effect-qb 0.24.1 cannot express the FOR UPDATE OF lock targets.
								const attempts = yield* sql.unsafe<{ status: string; has_output: boolean }>(
									"select a.status,exists(select 1 from grove_attempt_outputs x where x.attempt_id=a.id) has_output from grove_attempts a join grove_tasks t on t.object_id=a.task_id and t.role='work' and t.status='planned' where a.id=$1 and a.task_id=$2 for update of a,t",
									[input.attemptId, claim.task_id],
								);
								// The Task lock can wait beyond the lease. Revalidate with live
								// time after all publication locks, preserving committed fencing.
								const currentClaim = yield* validateClaim(input.claimId, input.fence, principal);

								if (currentClaim instanceof CommittedConflict) {
									return currentClaim;
								}

								if (attempts[0]?.status !== "running" || attempts[0].has_output) {
									return yield* new CommandConflict({
										message: "Attempt no longer accepts output",
									});
								}

								const scope = yield* run(
									executor.execute(
										Q.select({ scope: objects.scope }).pipe(
											Q.from(objects),
											Q.where(Q.eq(objects.id, claim.task_id)),
										),
									),
								);
								const objectId = crypto.randomUUID(),
									versionId = crypto.randomUUID();
								const payload = {
									type: "artifact",
									title: input.title,
									content: input.content,
									taskId: claim.task_id,
									attemptId: input.attemptId,
								};
								const digest = yield* canonicalDigest(payload);

								yield* run(
									executor.execute(
										Q.insert(objects, { id: objectId, kind: "artifact", scope: scope[0].scope }),
									),
								);

								yield* insertVersion(versionId, objectId, payload, digest, principal);
								yield* pointVersion(objectId, versionId);

								yield* run(
									executor.execute(
										Q.insert(outputs, {
											attempt_id: input.attemptId,
											task_id: claim.task_id,
											object_id: objectId,
											version_id: versionId,
										}),
									),
								);

								yield* run(
									executor.execute(
										Q.update(attemptsTable, {
											status: "result_submitted",
											result_submitted_at: Pg.Function.now(),
										}).pipe(Q.where(Q.eq(attemptsTable.id, input.attemptId))),
									),
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
						yield* requireProjectActor;

						// Writable live-clock CTE reconciles expiry and fencing atomically.
						yield* sql.unsafe(
							"with expired as (update grove_claims set status='expired' where status='leased' and expires_at<=clock_timestamp() returning attempt_id) update grove_attempts a set status='fenced' from expired e where a.id=e.attempt_id and a.status='running'",
						);

						// Substantial JSON/filtered ordered-array aggregation; read visibility
						// is project-scoped after current Actor capability checks.
						return yield* sql.unsafe<{
							taskId: string;
							title: string;
							dependencyTaskIds: string[];
						}>(
							"select t.object_id \"taskId\",v.payload->>'title' title,coalesce(array_agg(d.depends_on_task_id order by d.depends_on_task_id) filter(where d.depends_on_task_id is not null),'{}') \"dependencyTaskIds\" from grove_tasks t join grove_objects o on o.id=t.object_id join grove_object_versions v on v.id=o.current_version_id left join grove_task_dependencies d on d.task_id=t.object_id where t.parent_task_id=$1 and t.role='work' and t.status='planned' and not exists(select 1 from grove_task_dependencies x join grove_tasks dep on dep.object_id=x.depends_on_task_id where x.task_id=t.object_id and dep.status<>'completed') and not exists(select 1 from grove_claims c where c.task_id=t.object_id and c.status='leased') group by t.object_id,v.payload order by coalesce(array_length(array_agg(d.depends_on_task_id) filter(where d.depends_on_task_id is not null),1),0),t.object_id",
							[input.projectId],
						);
					}),
					"work.ready",
				),
		};
	}),
);
