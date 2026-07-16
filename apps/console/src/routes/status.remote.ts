import { ConsoleService } from "$lib/server/console/service";
import { Effect } from "effect";
import { Query } from "svelte-effect-runtime";

// Canonical status implementation. Exposed to the app as a SvelteKit remote query and re-used by
// the REST endpoint at /api/v1/status (see +server.ts), so the logic lives in exactly one place.
export const getStatus = Query(
	Effect.gen(function* () {
		const consoleService = yield* ConsoleService;
		return yield* consoleService.status;
	}),
);
