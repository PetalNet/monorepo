import { randomUUID } from "node:crypto";

import * as PgClient from "@effect/sql-pg/PgClient";
import { SvelteKitRequestEvent } from "@petalnet/effect-sveltekit";
import { Context, Effect, Layer } from "effect";

import type { ProjectCreate, ProjectCreateReceipt } from "../../projects/schema";
import { AuthenticationRequired, requireGrovePrincipal } from "../authorization";
import { canonicalDigest, canonicalJson } from "./canonical";

export class CommandConflict extends Error {
	readonly _tag = "CommandConflict";
}
export class ProjectDatabaseError extends Error {
	readonly _tag = "ProjectDatabaseError";
	constructor(readonly cause: unknown) {
		super("The project database is unavailable", { cause });
	}
}
type ProjectError = AuthenticationRequired | CommandConflict | ProjectDatabaseError;
export interface ProjectServiceShape {
	readonly create: (
		input: ProjectCreate,
	) => Effect.Effect<ProjectCreateReceipt, ProjectError, SvelteKitRequestEvent>;
}
export class ProjectService extends Context.Service<ProjectService, ProjectServiceShape>()(
	"grove/ProjectService",
) {}
const unavailable = () => Effect.die("Project data is unavailable during build");
export const ProjectServiceBuildLayer = Layer.succeed(ProjectService, { create: unavailable });

interface ReceiptRow {
	command_id: string;
	operation: string;
	principal_id: string;
	principal_kind: string;
	input_hash: string;
	object_id: string;
	version_id: string;
	version_digest: string;
}
export const ProjectServiceLayer = Layer.effect(
	ProjectService,
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient;
		return {
			create: (input) =>
				Effect.gen(function* () {
					const principal = yield* requireGrovePrincipal;
					const operation = "project.create";
					const commandId = input.commandId.toLowerCase();
					const inputHash = canonicalDigest({
						scope: input.scope,
						title: input.title,
						ask: input.ask,
					});
					return yield* sql.withTransaction(
						Effect.gen(function* () {
							yield* sql.unsafe("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
								commandId,
							]);
							const existing = yield* sql.unsafe<ReceiptRow>(
								"select command_id, operation, principal_id, principal_kind, input_hash, object_id, version_id, version_digest from grove_command_receipts where command_id = $1",
								[commandId],
							);
							if (existing.length > 0) {
								const receipt = existing[0];
								if (
									receipt.operation !== operation ||
									receipt.principal_id !== principal.id ||
									receipt.principal_kind !== principal.kind ||
									receipt.input_hash !== inputHash
								)
									return yield* Effect.fail(
										new CommandConflict("Command ID was already used with different input"),
									);
								return {
									commandId: receipt.command_id,
									objectId: receipt.object_id,
									versionId: receipt.version_id,
									versionDigest: receipt.version_digest,
									replayed: true,
								};
							}
							const objectId = randomUUID(),
								versionId = randomUUID(),
								outboxId = randomUUID();
							const payload = {
								ask: input.ask,
								scope: input.scope,
								title: input.title,
								type: "project",
							};
							const canonical = canonicalJson(payload),
								digest = canonicalDigest(payload);
							yield* sql.unsafe(
								"insert into grove_objects (id, kind, scope) values ($1, 'task', $2)",
								[objectId, input.scope],
							);
							yield* sql.unsafe(
								"insert into grove_object_versions (id, object_id, payload, digest, actor_id, actor_kind) values ($1, $2, $3::jsonb, $4, $5, $6)",
								[versionId, objectId, canonical, digest, principal.id, principal.kind],
							);
							yield* sql.unsafe("update grove_objects set current_version_id = $2 where id = $1", [
								objectId,
								versionId,
							]);
							yield* sql.unsafe(
								"insert into grove_project_tasks (object_id, role, status) values ($1, 'project', 'open')",
								[objectId],
							);
							yield* sql.unsafe(
								"insert into grove_command_receipts (command_id, operation, principal_id, principal_kind, input_hash, object_id, version_id, version_digest) values ($1, $2, $3, $4, $5, $6, $7, $8)",
								[
									commandId,
									operation,
									principal.id,
									principal.kind,
									inputHash,
									objectId,
									versionId,
									digest,
								],
							);
							yield* sql.unsafe(
								"insert into grove_outbox (id, command_id, version_id, event_type, aggregate_id, payload) values ($1, $2, $3, 'project.created', $4, $5::jsonb)",
								[
									outboxId,
									commandId,
									versionId,
									objectId,
									canonicalJson({ objectId, versionId, digest }),
								],
							);
							return {
								commandId,
								objectId,
								versionId,
								versionDigest: digest,
								replayed: false,
							};
						}).pipe(Effect.provideService(PgClient.PgClient, sql)),
					);
				}).pipe(
					Effect.mapError((error) =>
						error instanceof AuthenticationRequired || error instanceof CommandConflict
							? error
							: new ProjectDatabaseError(error),
					),
				),
		};
	}),
);
