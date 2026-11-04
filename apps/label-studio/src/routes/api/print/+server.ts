import type { JobResponse } from "$lib/api";
import { getApp } from "$lib/server/app";
import { fail, readBody, renderRequestPages } from "$lib/server/http";
import { defaultTitle, roundMm } from "$lib/server/labels";
import { printRequest } from "$lib/server/schemas";
import { json } from "@sveltejs/kit";

import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
	const body = await readBody(request, printRequest);

	if (!body.ok) {
		return fail(400, body.error);
	}

	const app = getApp();
	const rendered = await renderRequestPages(app, body.value);

	if (!rendered.ok) {
		return rendered.response;
	}

	const { design, pages } = rendered.value;
	const copies = body.value.copies ?? 1;
	const job = app.queue.submit({
		title: body.value.title ?? defaultTitle(design, pages[0].vars),
		templateId: design.template?.id ?? null,
		doc: design.doc,
		rows: pages.map((page) => page.vars),
		pages: pages.map((page) => page.png),
		lengthMm: roundMm(pages.reduce((sum, page) => sum + page.lengthMm, 0) * copies),
		copies,
		cut: body.value.cut ?? true,
		chain: body.value.chain ?? false,
		dryRun: body.value.dryRun ?? false,
	});
	const response: JobResponse = { job };

	return json(response, { status: 202 });
};
