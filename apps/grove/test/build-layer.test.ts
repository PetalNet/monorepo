import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { CurrentPrincipal } from "../src/lib/server/actors/authority";
import { ProjectService, ProjectServiceBuildLayer } from "../src/lib/server/projects/service";

describe("ProjectServiceBuildLayer", () => {
	it("initializes for prerender but defects if build code touches the database", async () => {
		const useService = Effect.flatMap(ProjectService, (service) =>
			service.ready({ projectId: "build" }),
		).pipe(
			Effect.provide(ProjectServiceBuildLayer),
			Effect.provideService(CurrentPrincipal, {
				kind: "unbound",
				issuer: "https://machine.example",
				subject: "build",
				scopes: new Set<string>(),
			}),
			Effect.exit,
		);
		const exit = await Effect.runPromise(useService);

		expect(Exit.isFailure(exit)).toBe(true);

		if (Exit.isFailure(exit)) {
			expect(Cause.hasDies(exit.cause)).toBe(true);
		}
	});
});
