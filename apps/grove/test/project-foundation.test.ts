import { createHash } from "node:crypto";

import * as PgClient from "@effect/sql-pg/PgClient";
import type { ApiServer } from "@petalnet/effect-api";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	ActorAuthority,
	ActorAuthorityLayer,
	type ActorPrincipal,
} from "../src/lib/server/actors/authority";
import { groveApi } from "../src/lib/server/api";
import { InvocationContext } from "../src/lib/server/invocation";
import { canonicalDigest } from "../src/lib/server/projects/canonical";
import type { ProjectService } from "../src/lib/server/projects/service";
import { ProjectServiceLayer } from "../src/lib/server/projects/service";
import type { SproutCommands } from "../src/lib/server/sprouts/service";
import { SproutCommandsLayer } from "../src/lib/server/sprouts/service";
import { startGrovePostgres, stopGrovePostgres } from "./postgres";

const operations = [
	"project.create",
	"project.plan",
	"task.claim",
	"claim.renew",
	"claim.release",
	"attempt.publish",
	"work.ready",
	"review.submit",
	"task.complete",
	"library.search",
	"library.getVersion",
];
const identity = { issuer: "https://identity.example/demo", subject: "owner" };

interface Receipt {
	readonly objectId: string;
	readonly versionId: string;
	readonly taskIds: Readonly<Record<string, string>>;
	readonly claimId: string;
	readonly fence: string;
	readonly attemptId: string;
	readonly reviewId: string;
}

describe("Grove project foundation and #401 REST/MCP loop", () => {
	let runtime: ManagedRuntime.ManagedRuntime<
		ActorAuthority | ProjectService | SproutCommands | ApiServer | PgClient.PgClient,
		unknown
	>;
	let database: ManagedRuntime.ManagedRuntime<PgClient.PgClient, unknown>;
	let owner: ActorPrincipal;
	let reviewer: ActorPrincipal;
	let agent: ActorPrincipal;

	beforeAll(async () => {
		const postgres = await startGrovePostgres();

		database = postgres.runtime;

		const actors = ActorAuthorityLayer({ homeOwner: identity }).pipe(
			Layer.provideMerge(PgClient.layer({ url: Redacted.make(postgres.databaseUrl) })),
		);
		const domain = Layer.merge(ProjectServiceLayer, SproutCommandsLayer).pipe(
			Layer.provideMerge(actors),
		);

		runtime = ManagedRuntime.make(Layer.merge(domain, groveApi.layer));

		owner = await runtime.runPromise(
			Effect.flatMap(ActorAuthority, (a) =>
				a.bindBrowserIdentity({
					...identity,
					authUserId: "demo-owner",
					name: "Owner",
					emailVerified: true,
				}),
			),
		);

		reviewer = await runtime.runPromise(
			Effect.flatMap(ActorAuthority, (a) =>
				a.bindBrowserIdentity({
					issuer: identity.issuer,
					subject: "reviewer",
					authUserId: "demo-reviewer",
					name: "Reviewer",
					emailVerified: true,
				}),
			),
		);

		agent = await runtime.runPromise(
			Effect.flatMap(ActorAuthority, (a) =>
				a.enrollSelf(
					{
						issuer: "https://machine.example",
						subject: "demo-agent",
						scopes: new Set(["grove:mcp", "grove:agent:enroll"]),
					},
					{ name: "Demo Agent" },
				),
			),
		);
	}, 60_000);

	afterAll(async () => {
		await runtime.dispose();
		await database.dispose();
		await stopGrovePostgres();
	});

	const rest = async (principal: ActorPrincipal, path: string, body?: object, status = 200) => {
		const response = await runtime.runPromise(
			groveApi
				.fetch(
					new Request(`https://grove.test/api/v1${path}`, {
						method: body ? "POST" : "GET",
						headers: { "content-type": "application/json" },
						...(body ? { body: JSON.stringify(body) } : {}),
					}),
				)
				.pipe(Effect.provideService(InvocationContext, { principal })),
		);

		expect(response.status).toBe(status);

		return response;
	};

	const mcp = async <A = Receipt>(principal: ActorPrincipal, name: string, args: object) => {
		const response = await runtime.runPromise(
			groveApi
				.mcp(
					new Request("https://grove.test/mcp", {
						method: "POST",
						headers: {
							"content-type": "application/json",
							accept: "application/json, text/event-stream",
							"mcp-protocol-version": "2026-07-28",
							"mcp-method": "tools/call",
							"mcp-name": name,
						},
						body: JSON.stringify({
							jsonrpc: "2.0",
							id: 1,
							method: "tools/call",
							params: {
								name,
								arguments: args,
								_meta: {
									"io.modelcontextprotocol/protocolVersion": "2026-07-28",
									"io.modelcontextprotocol/clientInfo": {
										name: "project-loop-test",
										version: "1.0.0",
									},
									"io.modelcontextprotocol/clientCapabilities": {},
								},
							},
						}),
					}),
				)
				.pipe(Effect.provideService(InvocationContext, { principal })),
		);

		expect(response.status).toBe(200);

		const json = (await response.json()) as {
			result: { isError: boolean; structuredContent: A };
		};

		expect(json.result.isError).toBe(false);

		return json.result.structuredContent;
	};

	it("canonicalizes nested keys and derives SHA-256 independently", async () => {
		const expected = '{"a":{"c":3,"d":4},"z":[{"a":1,"b":2}]}';
		const left = { z: [{ b: 2, a: 1 }], a: { d: 4, c: 3 } };

		expect(await Effect.runPromise(canonicalDigest(left))).toBe(
			createHash("sha256").update(expected).digest("hex"),
		);
	});

	it("exposes eleven operations and executes a mixed REST and enrolled-agent MCP loop", async () => {
		for (const operation of operations) {
			expect(JSON.stringify(groveApi.openapi)).toContain(operation);
		}

		const project = (await (
			await rest(owner, "/projects", {
				commandId: crypto.randomUUID(),
				scope: "demo",
				title: "Demo",
				ask: "Produce a reviewed loop proof",
			})
		).json()) as Receipt;
		const plan = await mcp(agent, "project.plan", {
			commandId: crypto.randomUUID(),
			projectId: project.objectId,
			expectedVersionId: project.versionId,
			tasks: [
				{
					key: "proof",
					title: "Write proof",
					objective: "Explain reviewed completion",
					completionContract: { requiredOutputs: ["artifact"], reviewRequired: true },
				},
			],
			dependencies: [],
		});
		const taskId = plan.taskIds.proof;
		const ready = (await (
			await rest(owner, `/projects/${project.objectId}/work/ready`)
		).json()) as readonly { taskId: string; taskVersionId: string }[];

		expect(ready.map((r) => r.taskId)).toEqual([taskId]);

		const released = await mcp(agent, "task.claim", {
			commandId: crypto.randomUUID(),
			taskId,
			leaseSeconds: 60,
		});

		await mcp(agent, "claim.release", {
			commandId: crypto.randomUUID(),
			claimId: released.claimId,
			fence: released.fence,
		});

		const claim = await mcp(agent, "task.claim", {
			commandId: crypto.randomUUID(),
			taskId,
			leaseSeconds: 60,
		});

		await mcp(agent, "claim.renew", {
			commandId: crypto.randomUUID(),
			claimId: claim.claimId,
			fence: claim.fence,
			leaseSeconds: 60,
		});

		const artifact = await mcp(agent, "attempt.publish", {
			commandId: crypto.randomUUID(),
			claimId: claim.claimId,
			fence: claim.fence,
			attemptId: claim.attemptId,
			title: "Proof",
			content: "Independent reviewed completion proof",
		});
		const review = (await (
			await rest(reviewer, "/reviews", {
				commandId: crypto.randomUUID(),
				taskId,
				attemptId: claim.attemptId,
				objectId: artifact.objectId,
				versionId: artifact.versionId,
				outcome: "accepted",
			})
		).json()) as Receipt;

		await rest(
			owner,
			`/tasks/${taskId}/complete`,
			{
				commandId: crypto.randomUUID(),
				taskId,
				expectedVersionId: project.versionId,
			},
			409,
		);

		await rest(owner, `/tasks/${taskId}/complete`, {
			commandId: crypto.randomUUID(),
			taskId,
			expectedVersionId: ready[0].taskVersionId,
		});

		const results = (await (
			await rest(owner, `/library/search?projectId=${project.objectId}&query=proof&limit=1`)
		).json()) as readonly { versionId: string }[];

		expect(results.map((r) => r.versionId)).toEqual([artifact.versionId]);

		const mcpResults = await mcp<readonly { versionId: string }[]>(agent, "library.search", {
			projectId: project.objectId,
			query: "proof",
			limit: 1,
		});

		expect(mcpResults.map((r) => r.versionId)).toEqual([artifact.versionId]);

		const pinned = await mcp(agent, "library.getVersion", {
			projectId: project.objectId,
			objectId: artifact.objectId,
			versionId: artifact.versionId,
		});

		expect(pinned).toMatchObject({
			versionId: artifact.versionId,
			reviewId: review.reviewId,
			authorId: agent.actorId,
			reviewerId: reviewer.actorId,
		});
	});

	it("accepts bounded REST search limits and rejects invalid query text", async () => {
		await Promise.all(
			["1", "50"].map((limit) =>
				rest(owner, `/library/search?projectId=unknown&query=proof&limit=${limit}`),
			),
		);

		await Promise.all(
			["0", "51", "1.5", "oops", "NaN", ""].map((limit) =>
				rest(owner, `/library/search?projectId=unknown&query=proof&limit=${limit}`, undefined, 400),
			),
		);
	});
});
