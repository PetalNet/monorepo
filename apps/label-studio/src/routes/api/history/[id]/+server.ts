import { getApp } from "$lib/server/app";
import { fail } from "$lib/server/http";
import { json } from "@sveltejs/kit";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ params }) => {
	const entry = getApp().store.getHistory(params.id);

	return entry ? json({ entry }) : fail(404, "No such history entry");
};
