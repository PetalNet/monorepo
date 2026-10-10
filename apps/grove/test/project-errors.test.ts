import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { ActorDenied, ActorNotCurrent } from "../src/lib/server/actors/authority";
import { projectOperations } from "../src/lib/server/projects/api";
import { CommandConflict, ProjectDatabaseError } from "../src/lib/server/projects/service";

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
] as const)("classifies %s by tag", (failure, status, publicMessage) => {
	const operation = projectOperations[0];
	const { _tag: tag } = failure;

	const declaration = operation.errors?.[tag];

	expect(declaration?.status).toBe(status);

	expect(
		typeof declaration?.message === "function"
			? declaration.message(failure)
			: declaration?.message,
	).toBe(publicMessage);
});

it.effect("command conflicts are yieldable tagged errors", () =>
	Effect.gen(function* () {
		const recovered = yield* new CommandConflict({ message: "Conflict" }).pipe(
			Effect.catchTag("CommandConflict", (error) => Effect.succeed(error.message)),
		);

		expect(recovered).toBe("Conflict");
	}),
);
