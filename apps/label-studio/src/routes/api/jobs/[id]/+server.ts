import { json } from "@sveltejs/kit";

import type { JobResponse } from "#lib/api.ts";
import { getApp } from "#lib/server/app.ts";
import { fail } from "#lib/server/http.ts";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ params }) => {
	const job = getApp().queue.job(params.id);

	if (!job) {
		return fail(404, "No such job; finished jobs are kept in history");
	}

	const response: JobResponse = { job };

	return json(response);
};
