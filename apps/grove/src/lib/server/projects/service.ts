import * as PgClient from "@effect/sql-pg/PgClient";
import { Context, Data, Effect, Layer, Match } from "effect";
import { Cast, Query, Type } from "effect-qb";
import * as Pg from "effect-qb/postgres";
import * as SqlClient from "effect/sql/SqlClient";

import type { ProjectCreate, ProjectCreateReceipt } from "../../projects/schema";
import { ActorAuthority, ActorDenied, type AuthorityError } from "../actors/authority";
import {
	grove_objects as objects,
	grove_object_versions as versions,
	grove_project_tasks as projects,
	grove_command_receipts as receipts,
	grove_outbox as outbox,
} from "../db/tables";
import { InvocationContext } from "../invocation";
import { canonicalDigest } from "./canonical";

const Q = { ...Query, ...Pg.Query };

export class CommandConflict extends Data.TaggedError("CommandConflict")<{
	readonly message: string;
}> {}
export class ProjectDatabaseError extends Data.TaggedError("ProjectDatabaseError")<{
	readonly cause: unknown;
}> {
	override get message() {
		return "The project database is unavailable";
	}
}
export type ProjectError = AuthorityError | CommandConflict | ProjectDatabaseError;
export interface ProjectServiceShape {
	readonly create: (
		input: ProjectCreate,
	) => Effect.Effect<ProjectCreateReceipt, ProjectError, InvocationContext>;
}
export class ProjectService extends Context.Service<ProjectService, ProjectServiceShape>()(
	"grove/ProjectService",
) {}
export const ProjectServiceBuildLayer = Layer.succeed(ProjectService, {
	create: () => Effect.die("Project data is unavailable during build"),
});
export const ProjectServiceLayer = Layer.effect(
	ProjectService,
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient;
		const authority = yield* ActorAuthority;
		const executor = Pg.Executor.make();
		const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
			effect.pipe(Effect.provideService(SqlClient.SqlClient, sql));

		return {
			create: (input) =>
				Effect.gen(function* () {
					const { principal } = yield* InvocationContext;

					if (principal.kind !== "person" && principal.kind !== "agent") {
						return yield* new ActorDenied({ reason: "An enrolled actor is required" });
					}

					const commandId = input.commandId.toLowerCase();
					const inputHash = yield* canonicalDigest({
						scope: input.scope,
						title: input.title,
						task: input.ask,
					});

					return yield* sql.withTransaction(
						Effect.gen(function* () {
							// Current authority locks and receipt replay share the command transaction.
							yield* authority.authorizeActor(principal, "project.create");

							yield* sql.unsafe("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
								commandId,
							]);

							const rows = yield* run(
								executor.execute(
									Q.select({
										commandId: receipts.command_id,
										operation: receipts.operation,
										principalId: receipts.principal_id,
										principalKind: receipts.principal_kind,
										inputHash: receipts.input_hash,
										objectId: receipts.object_id,
										versionId: receipts.version_id,
										versionDigest: receipts.version_digest,
									}).pipe(
										Q.from(receipts),
										Q.where(
											Q.eq(receipts.command_id, Q.literal(commandId).pipe(Cast.to(Type.uuid()))),
										),
									),
								),
							);
							const existing = rows.at(0);

							if (existing) {
								if (
									existing.operation !== "project.create" ||
									existing.principalId !== principal.actorId ||
									existing.principalKind !== principal.kind ||
									existing.inputHash !== inputHash
								) {
									return yield* new CommandConflict({
										message: "Command ID was already used with different input",
									});
								}

								return {
									commandId: existing.commandId,
									objectId: existing.objectId,
									versionId: existing.versionId,
									versionDigest: existing.versionDigest,
									replayed: true,
								};
							}

							const objectId = crypto.randomUUID(),
								versionId = crypto.randomUUID();
							const payload = {
								task: input.ask,
								scope: input.scope,
								title: input.title,
								type: "project",
								role: "project",
							};
							const versionDigest = yield* canonicalDigest(payload);

							yield* run(
								executor.execute(
									Q.insert(objects, { id: objectId, kind: "task", scope: input.scope }),
								),
							);

							yield* run(
								executor.execute(
									Q.insert(versions, {
										id: versionId,
										object_id: objectId,
										payload,
										digest: versionDigest,
										actor_id: principal.actorId,
										actor_kind: principal.kind,
									}),
								),
							);

							yield* run(
								executor.execute(
									Q.update(objects, { current_version_id: versionId }).pipe(
										Q.where(Q.eq(objects.id, objectId)),
									),
								),
							);

							yield* run(executor.execute(Q.insert(projects, { object_id: objectId })));

							yield* run(
								executor.execute(
									Q.insert(receipts, {
										command_id: commandId,
										operation: "project.create",
										principal_id: principal.actorId,
										principal_kind: principal.kind,
										input_hash: inputHash,
										object_id: objectId,
										version_id: versionId,
										version_digest: versionDigest,
									}),
								),
							);

							yield* run(
								executor.execute(
									Q.insert(outbox, {
										id: crypto.randomUUID(),
										command_id: commandId,
										version_id: versionId,
										event_type: "project.created",
										aggregate_id: objectId,
										payload: { objectId, versionId, digest: versionDigest },
									}),
								),
							);

							return { commandId, objectId, versionId, versionDigest, replayed: false };
						}),
					);
				}).pipe(
					Effect.mapError((error) =>
						Match.value(error).pipe(
							Match.tags({
								ActorDenied: (failure) => failure,
								ActorDatabaseError: (failure) => failure,
								ActorNotCurrent: (failure) => failure,
								HomeOwnerUnbound: (failure) => failure,
								CapabilityContainmentConflict: (failure) => failure,
								CommandConflict: (failure) => failure,
							}),
							Match.orElse((cause) => new ProjectDatabaseError({ cause })),
						),
					),
				),
		};
	}),
);
