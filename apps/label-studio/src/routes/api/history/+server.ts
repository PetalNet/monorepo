import { getApp } from "#lib/server/app.ts";
import { fail } from "#lib/server/http.ts";

import type { RequestHandler } from "./$types";

const MAX_LIMIT = 200;

export const GET: RequestHandler = ({ url }) => {
	const limitParam = url.searchParams.get("limit");
	const limit = limitParam === null ? 50 : Number(limitParam);

	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
		return fail(400, `limit must be a whole number from 1 to ${String(MAX_LIMIT)}`);
	}

	const before = url.searchParams.get("before") ?? undefined;

	return Response.json({ entries: getApp().store.listHistory(limit, before) });
};
