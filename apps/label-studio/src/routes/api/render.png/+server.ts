import { getApp } from "#lib/server/app.ts";
import { fail, pngResponse, readBody, renderRequestPages } from "#lib/server/http.ts";
import { renderRequest } from "#lib/server/schemas.ts";

import type { RequestHandler } from "./$types";

/** The first page as an image/png, for agents and previews that want bytes, not JSON. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await readBody(request, renderRequest);

	if (!body.ok) {
		return fail(400, body.error);
	}

	const rendered = await renderRequestPages(getApp(), body.value);

	if (!rendered.ok) {
		return rendered.response;
	}

	const [page] = rendered.value.pages;

	return pngResponse(page.png, {
		"x-label-length-mm": String(page.lengthMm),
		"x-label-pages": String(rendered.value.pages.length),
	});
};
