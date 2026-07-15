import { ConsoleService, type ConsoleStatus } from "$lib/server/console/service";
import { Handler } from "svelte-effect-runtime/server";

import type { RequestHandler } from "./$types";

export const GET = Handler<RequestHandler>(function* () {
	const consoleService = yield* ConsoleService;
	const status: ConsoleStatus = yield* consoleService.status;
	return Response.json(status);
});
