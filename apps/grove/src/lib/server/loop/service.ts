import { createHash, randomUUID } from "node:crypto";

import * as PgClient from "@effect/sql-pg/PgClient";
import { Context, Effect, Layer } from "effect";

import {
	ActorAuthority,
	ActorDenied,
	ActorNotCurrent,
	type ActorPrincipal,
	type AuthorityError,
} from "../actors/authority";
import { InvocationContext } from "../invocation";

export class LoopConflict extends Error {
	readonly _tag = "LoopConflict";
}
export class LoopDatabaseError extends Error {
	readonly _tag = "LoopDatabaseError";
	constructor(cause: unknown) {
		super("The Grove loop database is unavailable", { cause });
	}
}
export type LoopError = AuthorityError | LoopConflict | LoopDatabaseError;

type PrincipalEffect<A> = Effect.Effect<A, LoopError, InvocationContext>;
type Receipt = {
	readonly projectId?: string;
	readonly taskId?: string;
	readonly attemptId?: string;
	readonly versionId?: string;
	readonly [key: string]: unknown;
};
export interface LoopCommandsShape {
	readonly createProject: (input: { title: string; ask: string }) => PrincipalEffect<Receipt>;
	readonly planProject: (input: {
		projectId: string;
		expectedVersionId: string;
		title: string;
		objective: string;
	}) => PrincipalEffect<Receipt>;
	readonly readyWork: (input: { projectId: string }) => PrincipalEffect<readonly Receipt[]>;
	readonly claimTask: (input: { taskId: string }) => PrincipalEffect<Receipt>;
	readonly publishAttempt: (input: {
		attemptId: string;
		fence: string;
		title: string;
		content: string;
	}) => PrincipalEffect<Receipt>;
	readonly submitReview: (input: {
		attemptId: string;
		outcome: "accepted" | "rejected";
		comments?: string;
	}) => PrincipalEffect<Receipt>;
	readonly completeTask: (input: {
		taskId: string;
		expectedVersionId: string;
	}) => PrincipalEffect<Receipt>;
	readonly searchLibrary: (input: {
		projectId: string;
		query: string;
	}) => PrincipalEffect<readonly Receipt[]>;
}
export class LoopCommands extends Context.Service<LoopCommands, LoopCommandsShape>()(
	"grove/LoopCommands",
) {}
const unavailable = () => Effect.die("Grove loop is unavailable during build");
export const LoopCommandsBuildLayer = Layer.succeed(LoopCommands, {
	createProject: unavailable,
	planProject: unavailable,
	readyWork: unavailable,
	claimTask: unavailable,
	publishAttempt: unavailable,
	submitReview: unavailable,
	completeTask: unavailable,
	searchLibrary: unavailable,
});
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const actor = (principal: ActorPrincipal) => principal.actorId;

export const LoopCommandsLayer = Layer.effect(
	LoopCommands,
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient;
		const authority = yield* ActorAuthority;
		const command = <A>(
			operation: string,
			work: (principal: ActorPrincipal) => Effect.Effect<A, unknown>,
		) =>
			Effect.flatMap(InvocationContext, ({ principal }) => {
				if (principal.kind !== "person" && principal.kind !== "agent")
					return Effect.fail(new ActorDenied("An enrolled actor is required"));
				return sql
					.withTransaction(
						authority.authorizeActor(principal, operation).pipe(Effect.andThen(work(principal))),
					)
					.pipe(
						Effect.mapError((error) =>
							error instanceof LoopConflict ||
							error instanceof LoopDatabaseError ||
							error instanceof ActorDenied ||
							error instanceof ActorNotCurrent
								? error
								: new LoopDatabaseError(error),
						),
					);
			});
		return {
			createProject: (input) =>
				command("project.create", (principal) =>
					Effect.gen(function* () {
						const projectId = randomUUID(),
							versionId = randomUUID();
						yield* sql.unsafe(
							"insert into grove_loop_projects(id,title,ask,current_version_id,created_by_actor_id) values($1,$2,$3,$4,$5)",
							[projectId, input.title, input.ask, versionId, actor(principal)],
						);
						return { projectId, versionId };
					}),
				),
			planProject: (input) =>
				command("project.plan", (principal) =>
					Effect.gen(function* () {
						const taskId = randomUUID(),
							versionId = randomUUID(),
							projectVersionId = randomUUID();
						const projects = yield* sql.unsafe<{ id: string }>(
							"select id from grove_loop_projects where id=$1 and current_version_id=$2 for update",
							[input.projectId, input.expectedVersionId],
						);
						if (!projects[0]) return yield* Effect.fail(new LoopConflict("Stale project Version"));
						const existing = yield* sql.unsafe<{ exists: boolean }>(
							"select exists(select 1 from grove_loop_tasks where project_id=$1) exists",
							[input.projectId],
						);
						if (existing[0]?.exists)
							return yield* Effect.fail(new LoopConflict("Project is already planned"));
						yield* sql.unsafe(
							"insert into grove_loop_tasks(id,project_id,title,objective,status,version_id) values($1,$2,$3,$4,'planned',$5)",
							[taskId, input.projectId, input.title, input.objective, versionId],
						);
						yield* sql.unsafe("update grove_loop_projects set current_version_id=$2 where id=$1", [
							input.projectId,
							projectVersionId,
						]);
						return { projectId: input.projectId, taskId, versionId, projectVersionId };
					}),
				),
			readyWork: ({ projectId }) =>
				command("work.ready", () =>
					sql.unsafe<{ taskId: string; title: string; versionId: string }>(
						'select id "taskId",title,version_id "versionId" from grove_loop_tasks where project_id=$1 and status=\'planned\' and depends_on_task_id is null order by created_at',
						[projectId],
					),
				),
			claimTask: ({ taskId }) =>
				command("task.claim", (principal) =>
					Effect.gen(function* () {
						const attemptId = randomUUID(),
							fence = randomUUID();
						const rows = yield* sql.unsafe<{ version_id: string }>(
							"update grove_loop_tasks set status='claimed' where id=$1 and status='planned' returning version_id",
							[taskId],
						);
						if (!rows[0]) return yield* Effect.fail(new LoopConflict("Task is not ready"));
						yield* sql.unsafe(
							"insert into grove_loop_attempts(id,task_id,executor_actor_id,fence,status) values($1,$2,$3,$4,'running')",
							[attemptId, taskId, actor(principal), fence],
						);
						return { taskId, attemptId, fence, versionId: rows[0].version_id };
					}),
				),
			publishAttempt: (input) =>
				command("attempt.publish", (principal) =>
					Effect.gen(function* () {
						const attempts = yield* sql.unsafe<{ task_id: string }>(
							"select task_id from grove_loop_attempts where id=$1 and fence=$2 and executor_actor_id=$3 and status='running' for update",
							[input.attemptId, input.fence, actor(principal)],
						);
						const attempt = attempts[0];
						if (!attempt)
							return yield* Effect.fail(new LoopConflict("Attempt is fenced or not running"));
						const artifactId = randomUUID(),
							versionId = randomUUID(),
							hash = digest(`${input.title}\n${input.content}`);
						yield* sql.unsafe(
							"insert into grove_loop_artifacts(id,version_id,title,content,digest,created_by_actor_id) values($1,$2,$3,$4,$5,$6)",
							[artifactId, versionId, input.title, input.content, hash, actor(principal)],
						);
						yield* sql.unsafe(
							"update grove_loop_attempts set status='submitted',artifact_id=$2,artifact_version_id=$3 where id=$1",
							[input.attemptId, artifactId, versionId],
						);
						yield* sql.unsafe("update grove_loop_tasks set status='submitted' where id=$1", [
							attempt.task_id,
						]);
						return {
							attemptId: input.attemptId,
							taskId: attempt.task_id,
							artifactId,
							versionId,
							digest: hash,
						};
					}),
				),
			submitReview: (input) =>
				command("review.submit", (principal) =>
					Effect.gen(function* () {
						const attempts = yield* sql.unsafe<{ task_id: string; executor_actor_id: string }>(
							"select task_id,executor_actor_id from grove_loop_attempts where id=$1 and status='submitted' for update",
							[input.attemptId],
						);
						const attempt = attempts[0];
						if (!attempt) return yield* Effect.fail(new LoopConflict("Attempt is not reviewable"));
						if (attempt.executor_actor_id === actor(principal))
							return yield* Effect.fail(
								new LoopConflict("Attempt executors cannot review their own output"),
							);
						const reviewId = randomUUID(),
							versionId = randomUUID();
						yield* sql.unsafe(
							"insert into grove_loop_reviews(id,version_id,attempt_id,reviewer_actor_id,outcome,comments) values($1,$2,$3,$4,$5,$6)",
							[
								reviewId,
								versionId,
								input.attemptId,
								actor(principal),
								input.outcome,
								input.comments ?? null,
							],
						);
						yield* sql.unsafe("update grove_loop_attempts set status=$2 where id=$1", [
							input.attemptId,
							input.outcome === "accepted" ? "accepted" : "rejected",
						]);
						yield* sql.unsafe("update grove_loop_tasks set status=$2 where id=$1", [
							attempt.task_id,
							input.outcome === "accepted" ? "accepted" : "planned",
						]);
						return {
							reviewId,
							versionId,
							attemptId: input.attemptId,
							taskId: attempt.task_id,
							outcome: input.outcome,
						};
					}),
				),
			completeTask: (input) =>
				command("task.complete", (principal) =>
					Effect.gen(function* () {
						const rows = yield* sql.unsafe<{
							attempt_id: string;
							artifact_id: string;
							artifact_version_id: string;
							review_id: string;
							review_version_id: string;
						}>(
							"select a.id attempt_id,a.artifact_id,a.artifact_version_id,r.id review_id,r.version_id review_version_id from grove_loop_tasks t join grove_loop_attempts a on a.task_id=t.id and a.status='accepted' join grove_loop_reviews r on r.attempt_id=a.id and r.outcome='accepted' where t.id=$1 and t.version_id=$2 and t.status='accepted' for update",
							[input.taskId, input.expectedVersionId],
						);
						const row = rows[0];
						if (!row)
							return yield* Effect.fail(
								new LoopConflict("Task has no accepted reviewed output at this Version"),
							);
						const versionId = randomUUID();
						yield* sql.unsafe(
							"insert into grove_loop_completions(task_id,completion_version_id,attempt_id,artifact_id,artifact_version_id,review_id,review_version_id,completed_by_actor_id) values($1,$2,$3,$4,$5,$6,$7,$8)",
							[
								input.taskId,
								versionId,
								row.attempt_id,
								row.artifact_id,
								row.artifact_version_id,
								row.review_id,
								row.review_version_id,
								actor(principal),
							],
						);
						yield* sql.unsafe(
							"update grove_loop_tasks set status='completed',version_id=$2 where id=$1",
							[input.taskId, versionId],
						);
						return {
							taskId: input.taskId,
							versionId,
							artifactId: row.artifact_id,
							artifactVersionId: row.artifact_version_id,
							reviewId: row.review_id,
						};
					}),
				),
			searchLibrary: ({ projectId, query }) =>
				command("library.search", () =>
					sql.unsafe<{
						artifactId: string;
						versionId: string;
						title: string;
						content: string;
						taskId: string;
						reviewId: string;
					}>(
						'select a.id "artifactId",a.version_id "versionId",a.title,a.content,t.id "taskId",r.id "reviewId" from grove_loop_completions c join grove_loop_tasks t on t.id=c.task_id join grove_loop_artifacts a on a.id=c.artifact_id and a.version_id=c.artifact_version_id join grove_loop_reviews r on r.id=c.review_id and r.version_id=c.review_version_id where t.project_id=$1 and (a.title||\' \'||a.content) ilike \'%\'||$2||\'%\' order by c.created_at',
						[projectId, query],
					),
				),
		};
	}),
);
