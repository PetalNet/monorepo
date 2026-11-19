import { getApp } from "#lib/server/app.ts";
import { fail } from "#lib/server/http.ts";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ params }) => {
	const entry = getApp().store.getHistory(params.id);

	return entry ? Response.json({ entry }) : fail(404, "No such history entry");
};
