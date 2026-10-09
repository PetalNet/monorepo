import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgClient from "@effect/sql-pg/PgClient";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { applyMigrationFiles, readMigrationFilesEffect } from "effect-db/postgres/migrate";
import { loadPostgresSchemaPlanEffect } from "effect-db/postgres/push";
import { expect, it } from "vitest";

import config from "../effectdb.config";
import { ActorAuthority, ActorAuthorityLayer } from "../src/lib/server/actors/authority";
import { InvocationContext } from "../src/lib/server/invocation";
import { canonicalDigest } from "../src/lib/server/projects/canonical";
import { ProjectService, ProjectServiceLayer } from "../src/lib/server/projects/service";

const reviewPayload = (id: string, kind: string) =>
	JSON.stringify({
		type: "review",
		reviewer: { id, kind },
		taskId: "task",
		attemptId: "attempt",
		subject: { objectId: "artifact", versionId: "artifact-v1" },
		outcome: "accepted",
	});

const migrate = (databaseUrl: string, direction: "up" | "down" = "up", steps = 1) =>
	promisify(execFile)(
		process.execPath,
		[
			fileURLToPath(new URL("cli.js", import.meta.resolve("effect-db"))),
			"migrate",
			direction,
			...(direction === "down" ? ["--steps", String(steps)] : []),
		],
		{
			cwd: fileURLToPath(new URL("..", import.meta.url)),
			env: { ...process.env, DATABASE_URL: databaseUrl },
		},
	);

it("migrates a fresh stable auth schema idempotently through the unpatched CLI and rolls back failed multi-statement migrations", async () => {
	const container = await new PostgreSqlContainer("postgres:17-alpine").start();
	const runtime = ManagedRuntime.make(
		PgClient.layer({ url: Redacted.make(container.getConnectionUri()) }),
	);

	try {
		await migrate(container.getConnectionUri());
		await migrate(container.getConnectionUri());
		await migrate(container.getConnectionUri(), "down", 4);

		expect(
			await runtime.runPromise(
				Effect.flatMap(
					PgClient.PgClient,
					(sql) =>
						sql`select tablename from pg_tables where schemaname = 'public' order by tablename`,
				),
			),
		).toEqual([{ tablename: "effect_qb_migrations" }]);

		await migrate(container.getConnectionUri());

		const { plan, discovered } = await Effect.runPromise(
			loadPostgresSchemaPlanEffect(
				fileURLToPath(new URL("..", import.meta.url)),
				config,
				container.getConnectionUri(),
			).pipe(Effect.provide(NodeServices.layer)),
		);

		expect(discovered.model.tables.map((table) => table.name).toSorted()).toEqual([
			"account",
			"grove_actor_capabilities",
			"grove_actors",
			"grove_agent_access",
			"grove_agents",
			"grove_attempt_outputs",
			"grove_attempts",
			"grove_claims",
			"grove_command_receipts",
			"grove_demo_sprouts",
			"grove_external_identities",
			"grove_hosts",
			"grove_object_versions",
			"grove_objects",
			"grove_outbox",
			"grove_persons",
			"grove_reviews",
			"grove_task_completions",
			"grove_task_dependencies",
			"grove_tasks",
			"session",
			"user",
			"verification",
		]);

		expect(plan.changes).toEqual([]);

		await runtime.runPromise(
			Effect.gen(function* () {
				const migrations = yield* readMigrationFilesEffect(
					fileURLToPath(new URL("../migrations", import.meta.url)),
				);
				const sql = yield* PgClient.PgClient;

				expect(yield* sql`select id, runner_id, owner_person_id from grove_hosts`).toEqual([
					{ id: "host-local", runner_id: "runner-local", owner_person_id: null },
				]);

				expect(yield* sql`select name, waterings from grove_demo_sprouts`).toEqual([
					{ name: "Example fern", waterings: 0 },
				]);

				expect(yield* sql`select name from effect_qb_migrations order by name`).toEqual(
					migrations.map(({ name }) => ({ name })),
				);

				yield* sql`insert into "user" (id, name, email, "emailVerified") values ('user', 'Owner', 'owner@example.com', true)`;
				yield* sql`insert into account (id, "userId", "accountId", "providerId") values ('account', 'user', 'subject', 'grove-oidc')`;

				expect(
					yield* Effect.exit(
						sql`insert into account (id, "userId", "accountId", "providerId") values ('duplicate', 'user', 'subject', 'grove-oidc')`,
					),
				).toMatchObject({ _tag: "Failure" });

				yield* sql`insert into account (id, "userId", "accountId", "providerId") values ('other-provider', 'user', 'subject', 'other-provider')`;

				expect(
					yield* sql`select "providerId", "accountId" from account order by "providerId"`,
				).toEqual([
					{ providerId: "grove-oidc", accountId: "subject" },
					{ providerId: "other-provider", accountId: "subject" },
				]);

				const procedural = {
					name: "test_procedural.sql",
					checksum: "test",
					sql: `create table migration_probe (value text);
					do $$ begin insert into migration_probe values ('quoted;statement'); end $$;`,
				};

				yield* sql.withTransaction(applyMigrationFiles("effect_qb_migrations", [procedural]));

				expect(yield* sql`select value from migration_probe`).toEqual([
					{ value: "quoted;statement" },
				]);

				const failed = {
					name: "test_failure.sql",
					checksum: "test",
					sql: "insert into migration_probe values ('must roll back'); select * from missing_migration_table;",
				};

				expect(
					yield* Effect.exit(
						sql.withTransaction(applyMigrationFiles("effect_qb_migrations", [failed])),
					),
				).toMatchObject({ _tag: "Failure" });

				expect(yield* sql`select value from migration_probe`).toEqual([
					{ value: "quoted;statement" },
				]);

				expect(
					yield* sql`select name from effect_qb_migrations where name = 'test_failure.sql'`,
				).toEqual([]);
			}).pipe(Effect.provide(NodeServices.layer)),
		);
	} finally {
		await runtime.dispose();
		await container.stop();
	}
}, 60_000);

it("upgrades a durable 0002 project receipt with exact service replay and current authority", async () => {
	const container = await new PostgreSqlContainer("postgres:17-alpine").start();
	const url = container.getConnectionUri();
	const identity = { issuer: "https://identity.example/upgrade", subject: "owner" };
	const runtime = ManagedRuntime.make(
		ProjectServiceLayer.pipe(
			Layer.provideMerge(ActorAuthorityLayer({ homeOwner: identity })),
			Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })),
		),
	);

	try {
		await migrate(url);
		await migrate(url, "down", 2);

		const owner = await runtime.runPromise(
			Effect.flatMap(ActorAuthority, (authority) =>
				authority.bindBrowserIdentity({
					authUserId: "upgrade-owner",
					...identity,
					name: "Owner",
					emailVerified: true,
				}),
			),
		);
		const command = {
			commandId: "00000000-0000-0000-0000-000000000001",
			scope: "private",
			title: "Existing project",
			ask: "Existing ask",
		};
		const payload = {
			type: "project",
			role: "project",
			scope: command.scope,
			title: command.title,
			task: command.ask,
		};
		const receipt = {
			commandId: command.commandId,
			objectId: "project",
			versionId: "version",
			versionDigest: await Effect.runPromise(canonicalDigest(payload)),
			replayed: false,
		};

		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;

				// Simulate the defaults in the immutable first slice, not the new runtime defaults.
				yield* sql`delete from grove_actor_capabilities where capability in ('project.plan','work.ready','task.claim','claim.renew','claim.release','attempt.publish','review.submit','task.complete','library.search','library.getVersion')`;
				yield* sql`insert into grove_objects(id,kind,scope) values ('project','task',${command.scope})`;
				yield* sql`insert into grove_object_versions(id,object_id,payload,digest,actor_id,actor_kind) values ('version','project',${JSON.stringify(payload)}::jsonb,${receipt.versionDigest},${owner.actorId},'person')`;
				yield* sql`update grove_objects set current_version_id='version' where id='project'`;
				yield* sql`insert into grove_project_tasks(object_id) values ('project')`;
				yield* sql`insert into grove_command_receipts(command_id,operation,principal_id,principal_kind,input_hash,object_id,version_id,version_digest) values (${command.commandId}::uuid,'project.create',${owner.actorId},'person',${yield* canonicalDigest({ scope: command.scope, title: command.title, task: command.ask })},'project','version',${receipt.versionDigest})`;
				yield* sql`insert into grove_outbox(id,command_id,version_id,event_type,aggregate_id,payload) values ('event',${command.commandId}::uuid,'version','project.created','project',${JSON.stringify(receipt)}::jsonb)`;
			}),
		);

		await migrate(url);

		const replay = () =>
			runtime.runPromise(
				Effect.flatMap(ProjectService, (service) => service.create(command)).pipe(
					Effect.provideService(InvocationContext, { principal: owner }),
				),
			);

		expect(await replay()).toEqual({ ...receipt, replayed: true });

		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;

				expect(yield* sql`select response from grove_command_receipts`).toEqual([
					{ response: receipt },
				]);

				expect(yield* sql`select role,status from grove_tasks`).toEqual([
					{ role: "project", status: "planning" },
				]);

				expect(
					yield* sql`select count(*)::int count from grove_actor_capabilities where actor_id=${owner.actorId} and capability in ('project.plan','work.ready','task.claim','claim.renew','claim.release','attempt.publish')`,
				).toEqual([{ count: 6 }]);

				expect(
					yield* sql`select count(*)::int count from grove_actor_capabilities where actor_id=${owner.actorId} and capability in ('review.submit','task.complete','library.search','library.getVersion')`,
				).toEqual([{ count: 4 }]);
			}),
		);

		await runtime.runPromise(
			Effect.flatMap(ActorAuthority, (authority) =>
				authority.removePersonCapabilityAs(owner, owner.actorId, "project.create"),
			),
		);

		await expect(replay()).rejects.toMatchObject({ _tag: "ActorDenied" });

		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;

				expect(yield* sql`select response from grove_command_receipts`).toEqual([
					{ response: receipt },
				]);

				expect(yield* sql`select count(*)::int count from grove_outbox`).toEqual([{ count: 1 }]);
			}),
		);

		const { plan } = await Effect.runPromise(
			loadPostgresSchemaPlanEffect(fileURLToPath(new URL("..", import.meta.url)), config, url).pipe(
				Effect.provide(NodeServices.layer),
			),
		);

		expect(plan.changes).toEqual([]);
		// Representable project history survives a round-trip; execution history
		// refuses downgrade atomically rather than silently discarding provenance.
		await migrate(url, "down", 2);

		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;

				expect(yield* sql`select status from grove_project_tasks`).toEqual([{ status: "open" }]);

				expect(yield* sql`select version_id from grove_command_receipts`).toEqual([
					{ version_id: "version" },
				]);
			}),
		);

		await migrate(url);

		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;

				yield* sql`insert into grove_attempts(id,task_id,task_version_id,status,executor_id,executor_kind) values ('attempt','project','version','running',${owner.actorId},'person')`;
			}),
		);

		await migrate(url, "down");
		await expect(migrate(url, "down")).rejects.toThrow();

		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;

				expect(yield* sql`select id from grove_attempts`).toEqual([{ id: "attempt" }]);
				expect(yield* sql`select name from effect_qb_migrations order by name`).toHaveLength(3);
			}),
		);
	} finally {
		await runtime.dispose();
		await container.stop();
	}
}, 60_000);

it("upgrades populated Objects and enforces independent immutable review/completion provenance outside the schema model", async () => {
	const container = await new PostgreSqlContainer("postgres:17-alpine").start();
	const url = container.getConnectionUri();
	const runtime = ManagedRuntime.make(PgClient.layer({ url: Redacted.make(url) }));

	try {
		await migrate(url);
		await migrate(url, "down", 3);

		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;

				yield* sql`insert into grove_actors(id,kind,name) values ('author','agent','Author'),('reviewer','person','Reviewer')`;
				yield* sql`insert into "user"(id,name,email,"emailVerified") values ('existing','Existing owner','existing@example.com',true)`;
			}),
		);

		await migrate(url);
		await migrate(url, "down", 2);

		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;

				yield* sql`insert into grove_objects(id,kind,scope) values ('project','task','private')`;
				yield* sql`insert into grove_object_versions(id,object_id,payload,digest,actor_id,actor_kind) values ('project-v1','project','{}',${"a".repeat(64)},'author','agent')`;
				yield* sql`update grove_objects set current_version_id='project-v1' where id='project'`;
				yield* sql`insert into grove_project_tasks(object_id) values ('project')`;
				yield* sql`insert into grove_command_receipts(command_id,operation,principal_id,principal_kind,input_hash,object_id,version_id,version_digest) values ('00000000-0000-0000-0000-000000000001','project.create','author','agent','input','project','project-v1',${"a".repeat(64)})`;
				yield* sql`insert into grove_outbox(id,command_id,version_id,event_type,aggregate_id,payload) values ('event','00000000-0000-0000-0000-000000000001','project-v1','project.created','project','{}')`;
			}),
		);

		await migrate(url);

		const { plan } = await Effect.runPromise(
			loadPostgresSchemaPlanEffect(fileURLToPath(new URL("..", import.meta.url)), config, url).pipe(
				Effect.provide(NodeServices.layer),
			),
		);

		expect(plan.changes).toEqual([]);

		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;

				expect(yield* sql`select id from "user"`).toEqual([{ id: "existing" }]);

				expect(yield* sql`select role,status from grove_tasks where object_id='project'`).toEqual([
					{ role: "project", status: "planning" },
				]);

				expect(
					yield* sql`select response->>'versionId' as version_id from grove_command_receipts`,
				).toEqual([{ version_id: "project-v1" }]);

				yield* sql`insert into grove_objects(id,kind,scope) values ('task','task','private'),('other-task','task','private'),('artifact','artifact','private'),('review','review','private'),('self-review','review','private'),('bad-review','review','private')`;
				yield* sql`insert into grove_object_versions(id,object_id,payload,digest,actor_id,actor_kind) values ('task-v1','task','{}',${"b".repeat(64)},'author','agent'),('other-v1','other-task','{}',${"b".repeat(64)},'author','agent'),('artifact-v1','artifact','{}',${"b".repeat(64)},'author','agent')`;
				yield* sql`insert into grove_tasks(object_id,role,status,parent_task_id) values ('task','work','planned','project'),('other-task','work','planned','project')`;
				yield* sql`insert into grove_attempts(id,task_id,task_version_id,status,executor_id,executor_kind) values ('attempt','task','task-v1','running','author','agent')`;
				yield* sql`insert into grove_claims(id,task_id,attempt_id,fence,holder_id,holder_kind,status,expires_at) values ('claim','task','attempt','fence','author','agent','leased',now()+interval '1 hour')`;
				yield* sql`insert into grove_attempt_outputs(attempt_id,task_id,object_id,version_id) values ('attempt','task','artifact','artifact-v1')`;

				// Failed statements each have their own transaction; constraints and triggers stay enabled.
				for (const statement of [
					"update grove_object_versions set digest=repeat('c',64) where id='task-v1'",
					"delete from grove_object_versions where id='task-v1'",
					"truncate grove_object_versions cascade",
					"update grove_objects set current_version_id='artifact-v1' where id='task'",
					"insert into grove_object_versions(id,object_id,parent_version_id,payload,digest,actor_id,actor_kind) values ('bad-parent','task','artifact-v1','{}',repeat('c',64),'author','agent')",
					"insert into grove_object_versions(id,object_id,payload,digest,actor_id,actor_kind) values ('bad-kind','task','{}',repeat('c',64),'author','person')",
					"insert into grove_object_versions(id,object_id,payload,digest,actor_id,actor_kind) values ('missing-actor','task','{}',repeat('c',64),'missing','agent')",
					"update grove_actors set kind='person' where id='author'",
					"update grove_command_receipts set principal_kind='person'",
					"insert into grove_outbox(id,command_id,version_id,event_type,aggregate_id,payload) values ('orphan','00000000-0000-0000-0000-000000000002','artifact-v1','artifact.created','artifact','{}')",
					"insert into grove_outbox(id,command_id,version_id,event_type,aggregate_id,payload) values ('bad-version','00000000-0000-0000-0000-000000000001','artifact-v1','artifact.created','task','{}')",
					"insert into grove_attempts(id,task_id,task_version_id,status,executor_id,executor_kind) values ('bad-attempt','other-task','task-v1','running','author','agent')",
					"update grove_claims set task_id='other-task' where id='claim'",
					"update grove_claims set holder_kind='person' where id='claim'",
					"insert into grove_attempt_outputs(attempt_id,task_id,object_id,version_id) values ('missing-attempt','other-task','project','project-v1')",
					"update grove_attempts set executor_id='reviewer',executor_kind='person' where id='attempt'",
					"update grove_attempts set status='accepted' where id='attempt'",
					"update grove_attempt_outputs set version_id='task-v1' where attempt_id='attempt'",
					"delete from grove_attempt_outputs where attempt_id='attempt'",
					"truncate grove_attempt_outputs cascade",
				]) {
					expect(
						yield* Effect.exit(sql.withTransaction(sql.unsafe(statement))),
						statement,
					).toMatchObject({ _tag: "Failure" });
				}

				yield* sql`update grove_attempts set status='result_submitted',result_submitted_at=now() where id='attempt'`;
				yield* sql`insert into grove_object_versions(id,object_id,payload,digest,actor_id,actor_kind) values ('review-v1','review',${reviewPayload("reviewer", "person")}::jsonb,${"c".repeat(64)},'reviewer','person'),('self-v1','self-review',${reviewPayload("author", "agent")}::jsonb,${"c".repeat(64)},'author','agent'),('bad-review-v1','bad-review','{}',${"c".repeat(64)},'reviewer','person')`;

				for (const statement of [
					"insert into grove_reviews(object_id,version_id,reviewer_id,reviewer_kind,subject_object_id,subject_version_id,attempt_id,task_id,outcome) values ('self-review','self-v1','author','agent','artifact','artifact-v1','attempt','task','accepted')",
					"insert into grove_reviews(object_id,version_id,reviewer_id,reviewer_kind,subject_object_id,subject_version_id,attempt_id,task_id,outcome) values ('bad-review','bad-review-v1','reviewer','person','artifact','artifact-v1','attempt','task','accepted')",
					"insert into grove_reviews(object_id,version_id,reviewer_id,reviewer_kind,subject_object_id,subject_version_id,attempt_id,task_id,outcome) values ('review','review-v1','reviewer','person','artifact','artifact-v1','attempt','other-task','accepted')",
				]) {
					expect(
						yield* Effect.exit(sql.withTransaction(sql.unsafe(statement))),
						statement,
					).toMatchObject({ _tag: "Failure" });
				}

				yield* sql`insert into grove_reviews(object_id,version_id,reviewer_id,reviewer_kind,subject_object_id,subject_version_id,attempt_id,task_id,outcome) values ('review','review-v1','reviewer','person','artifact','artifact-v1','attempt','task','accepted')`;

				const completion = JSON.stringify({
					status: "completed",
					completion: {
						attemptId: "attempt",
						output: { objectId: "artifact", versionId: "artifact-v1" },
						review: { objectId: "review", versionId: "review-v1" },
					},
				});

				yield* sql`insert into grove_object_versions(id,object_id,parent_version_id,payload,digest,actor_id,actor_kind) values ('completion-v1','task','task-v1',${completion}::jsonb,${"d".repeat(64)},'reviewer','person'),('bad-completion','task','task-v1','{}',${"d".repeat(64)},'reviewer','person')`;

				const completionInsert =
					"insert into grove_task_completions(completion_version_id,task_id,task_version_id,attempt_id,output_object_id,output_version_id,review_object_id,review_version_id) values ('completion-v1','task','task-v1','attempt','artifact','artifact-v1','review','review-v1')";

				expect(yield* Effect.exit(sql.withTransaction(sql.unsafe(completionInsert)))).toMatchObject(
					{ _tag: "Failure" },
				);

				yield* sql`update grove_attempts set status='accepted' where id='attempt'`;

				expect(
					yield* Effect.exit(
						sql.withTransaction(
							sql.unsafe(completionInsert.replace("completion-v1", "bad-completion")),
						),
					),
				).toMatchObject({ _tag: "Failure" });

				yield* sql.unsafe(completionInsert);

				for (const statement of [
					"update grove_reviews set outcome='rejected' where object_id='review'",
					"delete from grove_reviews where object_id='review'",
					"truncate grove_reviews cascade",
					"update grove_task_completions set output_version_id='task-v1' where task_id='task'",
					"delete from grove_task_completions where task_id='task'",
					"truncate grove_task_completions",
					"update grove_attempts set status='running' where id='attempt'",
					"update grove_attempts set result_submitted_at=now()+interval '1 second' where id='attempt'",
				]) {
					expect(
						yield* Effect.exit(sql.withTransaction(sql.unsafe(statement))),
						statement,
					).toMatchObject({ _tag: "Failure" });
				}
			}),
		);

		await expect(migrate(url, "down")).rejects.toThrow();

		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;

				expect(yield* sql`select completion_version_id from grove_task_completions`).toEqual([
					{ completion_version_id: "completion-v1" },
				]);

				expect(yield* sql`select name from effect_qb_migrations order by name`).toHaveLength(4);
			}),
		);
	} finally {
		await runtime.dispose();
		await container.stop();
	}
}, 60_000);
