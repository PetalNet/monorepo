import type { RenderResponse } from "$lib/api";
import { tapeGeometry } from "$lib/doc";
import { getApp } from "$lib/server/app";
import { fail, readBody, renderRequestPages } from "$lib/server/http";
import { pngDataUrl } from "$lib/server/png";
import { renderRequest } from "$lib/server/schemas";
import { json } from "@sveltejs/kit";

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

	return json(response);
};
