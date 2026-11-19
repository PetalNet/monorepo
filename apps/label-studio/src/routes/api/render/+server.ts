import type { RenderResponse } from "#lib/api.ts";
import { tapeGeometry } from "#lib/doc.ts";
import { getApp } from "#lib/server/app.ts";
import { fail, readBody, renderRequestPages } from "#lib/server/http.ts";
import { pngDataUrl } from "#lib/server/png.ts";
import { renderRequest } from "#lib/server/schemas.ts";

import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
	const body = await readBody(request, renderRequest);

	if (!body.ok) {
		return fail(400, body.error);
	}

	const rendered = await renderRequestPages(getApp(), body.value);

	if (!rendered.ok) {
		return rendered.response;
	}

	const { design, pages } = rendered.value;
	const response: RenderResponse = {
		tape: tapeGeometry(design.doc.tapeMm),
		pages: pages.map((page) => ({
			png: pngDataUrl(page.png),
			lengthDots: page.lengthDots,
			lengthMm: page.lengthMm,
			vars: page.vars,
			warnings: page.warnings,
		})),
	};

	return Response.json(response);
};
