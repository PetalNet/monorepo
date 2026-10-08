import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgClient from "@effect/sql-pg/PgClient";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Effect, ManagedRuntime, Redacted } from "effect";
import { applyMigrationFiles, readMigrationFilesEffect } from "effect-db/postgres/migrate";
import { loadPostgresSchemaPlanEffect } from "effect-db/postgres/push";
import { expect, it } from "vitest";

import config from "../effectdb.config";

const migrate = (databaseUrl: string, direction: "up" | "down" = "up") =>
	promisify(execFile)(
		process.execPath,
		[fileURLToPath(new URL("cli.js", import.meta.resolve("effect-db"))), "migrate", direction],
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
		await migrate(container.getConnectionUri(), "down");

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
			"grove_demo_sprouts",
			"grove_external_identities",
			"grove_hosts",
			"grove_persons",
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
