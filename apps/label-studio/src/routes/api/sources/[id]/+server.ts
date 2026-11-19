import { json } from "@sveltejs/kit";

import { getApp } from "#lib/server/app.ts";
import { fail } from "#lib/server/http.ts";
import { isSourceId, readSource, SOURCES } from "#lib/server/sources/index.ts";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params }) => {
	if (!isSourceId(params.id)) {
		return fail(404, "No such source");
	}

	const app = getApp();
	const config = app.config.sources[params.id];

	if (!config) {
		return fail(503, `${SOURCES[params.id].label} is not configured on this server`);
	}

	const result = await readSource(params.id, config, app.now);

	return result.ok ? json(result.rows) : fail(502, result.error);
};
