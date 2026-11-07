import type { JobResponse } from "$lib/api";
import { getApp } from "$lib/server/app";
import { fail } from "$lib/server/http";
import { json } from "@sveltejs/kit";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ params }) => {
	const job = getApp().queue.job(params.id);

	if (!job) {
		return fail(404, "No such job; finished jobs are kept in history");
	}

	const response: JobResponse = { job };

	return json(response);
};
