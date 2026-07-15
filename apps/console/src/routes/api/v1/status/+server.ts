import { ConsoleService, type ConsoleStatus } from "$lib/server/console/service";
import { runServerEffect } from "$lib/server/runtime/run";
import type { RequestHandler } from "./$types";
import { Effect } from "effect";

export const GET: RequestHandler = async () => {
	const status: ConsoleStatus = await runServerEffect(
		Effect.gen(function* () {
			const consoleService = yield* ConsoleService;
			return yield* consoleService.status;
		}),
	);
	return Response.json(status);
};
