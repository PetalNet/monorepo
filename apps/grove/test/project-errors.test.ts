import { expect, it } from "@effect/vitest";
import { mapOperationErrors } from "@petalnet/effect-api";
import { makeEffectSvelteKitRuntime } from "@petalnet/effect-sveltekit";
import type { RequestEvent } from "@sveltejs/kit";
import { Cause, Effect, Layer } from "effect";

import {
	ActorDatabaseError,
	ActorDenied,
	ActorNotCurrent,
	HomeOwnerUnbound,
	CapabilityContainmentConflict,
} from "../src/lib/server/actors/authority";
import { projectErrors, projectOperations } from "../src/lib/server/projects/api";
import {
	CommandConflict,
	FenceConflict,
	ProjectDatabaseError,
	type ProjectError,
} from "../src/lib/server/projects/service";

it.each([
	[new CommandConflict({ message: "Conflicting command" }), 409, "Conflicting command"],
	[new ActorDenied({ reason: "Capability revoked" }), 403, "Capability revoked"],
	[
		new ActorNotCurrent({ actorId: "suspended-agent" }),
		403,
		"Actor suspended-agent is not current",
	],
	[
		new ProjectDatabaseError({ cause: "Private database detail" }),
		503,
		"The project database is unavailable",
	],
	[new FenceConflict({ message: "Stale claim" }), 409, "Stale claim"],
	[
		new ActorDatabaseError({ cause: "Private authority detail" }),
		503,
		"The project database is unavailable",
	],
	[
		new HomeOwnerUnbound({
			configuredIdentity: { issuer: "https://id.example", subject: "owner" },
		}),
		503,
		"The project database is unavailable",
	],
	[
		new CapabilityContainmentConflict({ conflicts: [], fixes: [] }),
		503,
		"The project database is unavailable",
	],
] as const)(
	"shares the public policy for %s between operations and SvelteKit",
	async (failure, status, publicMessage) => {
		const operation = projectOperations[0];
		const { _tag: tag } = failure;

		const declaration = operation.errors?.[tag];

		expect(declaration?.status).toBe(status);

		expect(
			typeof declaration?.message === "function"
				? declaration.message(failure)
				: declaration?.message,
		).toBe(publicMessage);

		const logged: Cause.Cause<unknown>[] = [];
		const runtime = makeEffectSvelteKitRuntime(Layer.empty, {
			mapFailure: mapOperationErrors<ProjectError>(projectErrors),
			logCause: (cause) => {
				logged.push(cause);
			},
		});

		try {
			await expect(
				runtime.run(Effect.fail(failure), {
					request: new Request("https://grove.example/"),
				} as RequestEvent),
			).rejects.toMatchObject({ status, body: { message: publicMessage } });

			expect(logged).toEqual(status >= 500 ? [Cause.fail(failure)] : []);
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
