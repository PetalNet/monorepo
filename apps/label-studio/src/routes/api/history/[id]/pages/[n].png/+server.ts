import { getApp } from "$lib/server/app";
import { fail, pngResponse } from "$lib/server/http";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ params }) => {
	const n = Number(params.n);
	const png = Number.isInteger(n) && n >= 0 ? getApp().store.historyPage(params.id, n) : null;

	return png ? pngResponse(new Uint8Array(png)) : fail(404, "No such page");
};
