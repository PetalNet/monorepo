import { ConsoleService } from "$lib/server/effect/console-service";
import { runServerEffect } from "$lib/server/effect/run";
import { expose } from "$lib/server/http/expose";
import { Effect } from "effect";

export const GET = expose(() =>
	runServerEffect(
		Effect.gen(function* () {
			const consoleService = yield* ConsoleService;
			return yield* consoleService.status;
		}),
	),
);
