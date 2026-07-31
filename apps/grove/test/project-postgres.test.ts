import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import * as PgClient from "@effect/sql-pg/PgClient";
import { SvelteKitRequestEvent } from "@petalnet/effect-sveltekit";
import type { RequestEvent } from "@sveltejs/kit";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ProjectCreate } from "../src/lib/projects/schema";
import {
	CommandConflict,
	ProjectDatabaseError,
	ProjectService,
	ProjectServiceLayer,
} from "../src/lib/server/projects/service";

const input = (commandId: string = randomUUID()) => ({
	commandId,
	scope: "team/core",
	title: "Ship Grove",
	ask: "Create the object foundation",
});

describe("ProjectService PostgreSQL integration", async () => {
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
			join grove_project_tasks t on t.object_id = o.id
			join grove_command_receipts r on r.object_id = o.id
			join grove_outbox x on x.command_id = r.command_id
			where o.id = '${receipt.objectId}'`);
		expect(rows).toEqual([
			expect.objectContaining({
				current_version_id: receipt.versionId,
				version_id: receipt.versionId,
				role: "project",
				status: "open",
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
			(select count(*)::int from grove_project_tasks) tasks,
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
});
