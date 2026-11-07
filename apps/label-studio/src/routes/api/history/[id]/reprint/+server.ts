import type { JobResponse } from "$lib/api";
import { getApp } from "$lib/server/app";
import { fail, readBody } from "$lib/server/http";
import { roundMm } from "$lib/server/labels";
import { reprintRequest } from "$lib/server/schemas";
import { json } from "@sveltejs/kit";

import type { RequestHandler } from "./$types";

/** Sends the stored rasters again, so a reprint matches the original exactly. */
export const POST: RequestHandler = async ({ params, request }) => {
	const body = await readBody(request, reprintRequest, { emptyAsObject: true });

	if (!body.ok) {
		return fail(400, body.error);
	}

	const app = getApp();
	const entry = app.store.getHistory(params.id);

	if (!entry) {
		return fail(404, "No such history entry");
	}

	const copies = body.value.copies ?? entry.copies;
	const job = app.queue.submit({
		title: entry.title,
		templateId: entry.templateId,
		doc: entry.doc,
		rows: entry.rows,
		pages: app.store.historyPages(entry.id),
		lengthMm: roundMm((entry.lengthMm / entry.copies) * copies),
		copies,
		cut: entry.cut,
		chain: entry.chain,
		dryRun: body.value.dryRun ?? entry.dryRun,
	});
	const response: JobResponse = { job };

	return json(response, { status: 202 });
};
