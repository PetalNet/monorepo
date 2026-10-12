import { expect, it } from "@effect/vitest";
import { createEffectApi, mapOperationErrors } from "@petalnet/effect-api";
import { http, makeEffectSvelteKitRuntime } from "@petalnet/effect-sveltekit";
import { Cause, Effect, Layer, ManagedRuntime, Option } from "effect";

import { enrollAgentSelfOperation } from "../src/lib/server/actors/api";
import {
	ActorAuthority,
	ActorAuthorityBuildLayer,
	ActorDatabaseError,
	ActorDenied,
	ActorNotCurrent,
	HomeOwnerUnbound,
	CapabilityContainmentConflict,
} from "../src/lib/server/actors/authority";
import { CurrentPrincipal } from "../src/lib/server/actors/authority";
import { projectErrors } from "../src/lib/server/projects/api";
import {
	CommandConflict,
	FenceConflict,
	ProjectDatabaseError,
	type ProjectError,
} from "../src/lib/server/projects/service";
import { requestEvent } from "./request-event";

const authorityFailures = [
	[new ActorDenied({ reason: "Capability revoked" }), 403, "Capability revoked"],
	[
		new ActorNotCurrent({ actorId: "suspended-agent" }),
		403,
		"Actor suspended-agent is not current",
	],
	[
		new ActorDatabaseError({ cause: "Private authority detail" }),
		503,
		"Actor authority is unavailable",
	],
	[
		new HomeOwnerUnbound({
			configuredIdentity: { issuer: "https://id.example", subject: "owner" },
		}),
		503,
		"The configured Home Host owner has not completed a verified browser login",
	],
	[
		new CapabilityContainmentConflict({ conflicts: [], fixes: [] }),
		409,
		"Agent capability containment would be violated",
	],
] as const;

it.each([
	...authorityFailures,
	[new CommandConflict({ message: "Conflicting command" }), 409, "Conflicting command"],
	[
		new ProjectDatabaseError({ cause: "Private database detail" }),
		503,
		"The project database is unavailable",
	],
	[new FenceConflict({ message: "Stale claim" }), 409, "Stale claim"],
] as const)(
	"exposes the public project failure %s through SvelteKit",
	async (failure, status, publicMessage) => {
		const logged: Cause.Cause<unknown>[] = [];
		const runtime = makeEffectSvelteKitRuntime(Layer.empty, {
			mapFailure: mapOperationErrors<ProjectError>(projectErrors),
			logCause: (cause) => {
				logged.push(cause);
			},
		});

		try {
			await expect(
				runtime.run(Effect.fail(failure), requestEvent(new Request("https://grove.example/"))),
			).rejects.toMatchObject({ status, body: { message: publicMessage } });

			expect(logged.map(Cause.findErrorOption)).toEqual(
				status >= 500 ? [Option.some(failure)] : [],
			);
		} finally {
			await runtime.dispose();
		}
	},
);

it.each(authorityFailures)(
	"exposes safe enrollment failures and logs server outages for %s",
	async (failure, status, publicMessage) => {
		const logged: Cause.Cause<unknown>[] = [];
		const application = createEffectApi({
			title: "Enrollment",
			version: "1",
			basePath: "/api",
			operations: [enrollAgentSelfOperation],
			logCause: (_operation, cause) => logged.push(cause),
		});
		const runtime = ManagedRuntime.make(Layer.merge(ActorAuthorityBuildLayer, application));

		try {
			const authority = await runtime.runPromise(ActorAuthority);
			const response = await runtime.runPromise(
				http(
					new Request("https://grove.example/mcp", {
						method: "POST",
						headers: {
							"content-type": "application/json",
							accept: "application/json, text/event-stream",
							"mcp-protocol-version": "2026-07-28",
							"mcp-method": "tools/call",
							"mcp-name": "agents.enrollSelf",
						},
						body: JSON.stringify({
							jsonrpc: "2.0",
							id: 1,
							method: "tools/call",
							params: {
								name: "agents.enrollSelf",
								arguments: { name: "Enrollment policy" },
								_meta: {
									"io.modelcontextprotocol/protocolVersion": "2026-07-28",
									"io.modelcontextprotocol/clientInfo": { name: "policy-test", version: "1" },
									"io.modelcontextprotocol/clientCapabilities": {},
								},
							},
						}),
					}),
				).pipe(
					Effect.provideService(ActorAuthority, {
						...authority,
						enrollSelf: () => Effect.fail(failure),
					}),
					Effect.provideService(CurrentPrincipal, {
						kind: "bootstrap",
						issuer: "https://id.example",
						subject: "machine",
						scopes: new Set(["grove:agent:enroll"]),
					}),
				),
			);

			expect(response.status).toBe(200);

			expect(await response.json()).toMatchObject({
				result: {
					isError: true,
					structuredContent: { error: { code: "operation_failed", message: publicMessage } },
				},
			});

			expect(logged.map(Cause.findErrorOption)).toEqual(
				status >= 500 ? [Option.some(failure)] : [],
			);
		} finally {
			await runtime.dispose();
		}
	},
);

it.effect("command conflicts are yieldable tagged errors", () =>
	Effect.gen(function* () {
		const recovered = yield* new CommandConflict({ message: "Conflict" }).pipe(
			Effect.catchTag("CommandConflict", (error) => Effect.succeed(error.message)),
		);

		expect(recovered).toBe("Conflict");
	}),
);
