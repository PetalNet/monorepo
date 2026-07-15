import { ConsoleService } from "$lib/server/console/service";
import { Effect } from "effect";
import { Query } from "svelte-effect-runtime";

export const getStatus = Query(
	Effect.gen(function* () {
		const consoleService = yield* ConsoleService;
		return yield* consoleService.status;
	}),
);
