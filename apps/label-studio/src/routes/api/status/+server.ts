import type { StatusResponse } from "$lib/api";
import { getApp } from "$lib/server/app";
import { json } from "@sveltejs/kit";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
	const app = getApp();
	const body: StatusResponse = { printer: await app.printer.status(), queue: app.queue.snapshot() };

	return json(body);
};
