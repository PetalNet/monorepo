import { SvelteKitRequestEvent } from "@petalnet/effect-sveltekit";
import type { RequestEvent } from "@sveltejs/kit";
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { ProjectService, ProjectServiceBuildLayer } from "../src/lib/server/projects/service";
import { SproutService, SproutServiceBuildLayer } from "../src/lib/server/sprouts/service";

describe("SproutServiceBuildLayer", () => {
	it("initializes for prerender but defects if build code touches the database", async () => {
		const useService = Effect.flatMap(SproutService, (service) => service.list).pipe(
			Effect.provide(SproutServiceBuildLayer),
			Effect.provideService(SvelteKitRequestEvent, {
				request: new Request("https://grove.test/prerender"),
			} as RequestEvent),
			Effect.exit,
		);
		const exit = await Effect.runPromise(useService);

		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(true);
	});
});

describe("ProjectServiceBuildLayer", () => {
	it("initializes for prerender but defects if build code creates a project", async () => {
		const useService = Effect.flatMap(ProjectService, (service) =>
			service.create({
				commandId: "874b6ca2-5050-4e3f-8bd7-10d3b4069db8",
				scope: "build",
				title: "Build",
				ask: "Do not access PostgreSQL",
			}),
		).pipe(
			Effect.provide(ProjectServiceBuildLayer),
			Effect.provideService(SvelteKitRequestEvent, {
				request: new Request("https://grove.test/prerender"),
			} as RequestEvent),
			Effect.exit,
		);
		const exit = await Effect.runPromise(useService);

		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(true);
	});
});
