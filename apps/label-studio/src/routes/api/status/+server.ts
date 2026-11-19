import type { StatusResponse } from "#lib/api.ts";
import { getApp } from "#lib/server/app.ts";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
	const app = getApp();
	const body: StatusResponse = { printer: await app.printer.status(), queue: app.queue.snapshot() };

	return Response.json(body);
};
