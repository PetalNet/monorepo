import * as PgClient from "@effect/sql-pg/PgClient";
import { http, SvelteKitRequestEvent } from "@petalnet/effect-sveltekit";
import type { RequestEvent } from "@sveltejs/kit";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { HttpServerRequest } from "effect/http";
import { expect, it } from "vitest";

import { ActorAuthority, ActorAuthorityLayer } from "../src/lib/server/actors/authority";
import { groveApi } from "../src/lib/server/api";
import { InvocationContext } from "../src/lib/server/invocation";
import { canonicalDigest } from "../src/lib/server/projects/canonical";
import { ProjectService, ProjectServiceLayer } from "../src/lib/server/projects/service";
import { startGrovePostgres, stopGrovePostgres } from "./postgres";

it("creates through REST, binds replay to current authority, preserves Versions and rolls back the whole command", async () => {
	const postgres = await startGrovePostgres();
	const database = PgClient.layer({ url: Redacted.make(postgres.databaseUrl) });
	const identity = { issuer: "https://owner.example", subject: "owner" };
	const actors = ActorAuthorityLayer({ homeOwner: identity }).pipe(Layer.provideMerge(database));
	const runtime = ManagedRuntime.make(
		Layer.mergeAll(ProjectServiceLayer.pipe(Layer.provideMerge(actors)), groveApi.layer),
	);

	try {
		const owner = await runtime.runPromise(
			Effect.flatMap(ActorAuthority, (authority) =>
				authority.bindBrowserIdentity({
					...identity,
					authUserId: "owner",
					name: "Owner",
					emailVerified: true,
				}),
			),
		);
		const input = { commandId: crypto.randomUUID(), scope: "home", title: "Title", ask: "Ask" };
		const response = await runtime.runPromise(
			http(
				HttpServerRequest.fromWeb(
					new Request("http://grove.example/api/v1/projects", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(input),
					}),
				),
			).pipe(
				Effect.provideService(SvelteKitRequestEvent, {
					locals: { actor: owner },
				} as RequestEvent),
			),
		);

		expect(response.status).toBe(200);

		const receipt = await runtime.runPromise(
			Effect.flatMap(ProjectService, (service) => service.create(input)).pipe(
				Effect.provideService(InvocationContext, { principal: owner }),
			),
		);

		expect(receipt.replayed).toBe(true);

		const conflicting = await runtime.runPromiseExit(
			Effect.flatMap(ProjectService, (service) =>
				service.create({ ...input, ask: "Different" }),
			).pipe(Effect.provideService(InvocationContext, { principal: owner })),
		);

		expect(conflicting).toMatchObject({ _tag: "Failure" });

		const other = await runtime.runPromise(
			Effect.flatMap(ActorAuthority, (authority) =>
				authority.bindBrowserIdentity({
					issuer: identity.issuer,
					subject: "other",
					authUserId: "other",
					name: "Other",
					emailVerified: true,
				}),
			),
		);
		const stolen = await runtime.runPromiseExit(
			Effect.flatMap(ProjectService, (service) => service.create(input)).pipe(
				Effect.provideService(InvocationContext, { principal: other }),
			),
		);

		expect(stolen).toMatchObject({ _tag: "Failure" });

		const concurrent = await Promise.all(
			Array.from({ length: 4 }, () =>
				runtime.runPromise(
					Effect.flatMap(ProjectService, (service) => service.create(input)).pipe(
						Effect.provideService(InvocationContext, { principal: owner }),
					),
				),
			),
		);

		for (const replay of concurrent) {
			expect(replay).toEqual(receipt);
		}

		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;

				expect(yield* sql`select payload, digest from grove_object_versions`).toEqual([
					{
						payload: {
							task: "Ask",
							scope: "home",
							title: "Title",
							type: "project",
							role: "project",
						},
						digest: receipt.versionDigest,
					},
				]);

				expect(receipt.versionDigest).toBe(
					yield* canonicalDigest({
						task: "Ask",
						scope: "home",
						title: "Title",
						type: "project",
						role: "project",
					}),
				);

				expect(yield* sql`select role, status from grove_tasks`).toEqual([
					{ role: "project", status: "planning" },
				]);

				for (const statement of [
					"update grove_object_versions set digest = digest",
					"delete from grove_object_versions",
					"truncate grove_object_versions cascade",
				]) {
					expect(yield* Effect.exit(sql.unsafe(statement))).toMatchObject({ _tag: "Failure" });
				}

				yield* sql`create function reject_outbox() returns trigger language plpgsql as $$ begin raise exception 'test rollback'; end $$`;
				yield* sql`create trigger reject_outbox before insert on grove_outbox for each row execute function reject_outbox()`;
			}),
		);

		const failed = await runtime.runPromiseExit(
			Effect.flatMap(ProjectService, (service) =>
				service.create({ ...input, commandId: crypto.randomUUID() }),
			).pipe(Effect.provideService(InvocationContext, { principal: owner })),
		);

		expect(failed).toMatchObject({ _tag: "Failure" });

		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;

				for (const table of [
					"grove_objects",
					"grove_object_versions",
					"grove_tasks",
					"grove_command_receipts",
					"grove_outbox",
				]) {
					expect(yield* sql.unsafe(`select count(*)::int as count from ${table}`)).toEqual([
						{ count: 1 },
					]);
				}
			}),
		);

		await runtime.runPromise(
			Effect.flatMap(ActorAuthority, (authority) =>
				authority.removePersonCapabilityAs(owner, owner.actorId, "project.create"),
			),
		);

		const denied = await runtime.runPromiseExit(
			Effect.flatMap(ProjectService, (service) => service.create(input)).pipe(
				Effect.provideService(InvocationContext, { principal: owner }),
			),
		);

		expect(denied).toMatchObject({ _tag: "Failure" });

		const agent = await runtime.runPromise(
			Effect.flatMap(ActorAuthority, (authority) =>
				authority.enrollSelf(
					{
						issuer: "https://machine.example",
						subject: "after-owner-revocation",
						scopes: new Set(["grove:mcp", "grove:agent:enroll"]),
					},
					{ name: "Contained Agent" },
				),
			),
		);

		expect(
			await runtime.runPromise(
				Effect.flatMap(ActorAuthority, (authority) => authority.authorizedOperations(agent)),
			),
		).not.toContain("project.create");

		await expect(
			runtime.runPromise(
				Effect.flatMap(ProjectService, (service) =>
					service.create({ ...input, commandId: crypto.randomUUID() }),
				).pipe(Effect.provideService(InvocationContext, { principal: agent })),
			),
		).rejects.toMatchObject({ _tag: "ActorDenied" });
	} finally {
		await runtime.dispose();
		await postgres.runtime.dispose();
		await stopGrovePostgres();
	}
}, 60_000);
