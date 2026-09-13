import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { InvocationContext } from "../src/lib/server/invocation";
import { SproutCommands, SproutCommandsBuildLayer } from "../src/lib/server/sprouts/service";

describe("SproutCommandsBuildLayer", () => {
	it("initializes for prerender but defects if build code touches the database", async () => {
		const useService = Effect.flatMap(SproutCommands, (commands) => commands.list).pipe(
			Effect.provide(SproutCommandsBuildLayer),
			Effect.provideService(InvocationContext, {
				principal: {
					kind: "unbound",
					issuer: "https://machine.example",
					subject: "build",
					scopes: new Set<string>(),
				},
				transport: "browser",
				requestId: "build",
			}),
			Effect.exit,
		);
		const exit = await Effect.runPromise(useService);

		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(true);
	});
});
