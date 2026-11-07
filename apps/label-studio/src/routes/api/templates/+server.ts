import type { Template } from "$lib/doc";
import { getApp } from "$lib/server/app";
import { fail, readBody } from "$lib/server/http";
import { templateInput } from "$lib/server/schemas";
import { allTemplates, findTemplate } from "$lib/server/templates";
import { json } from "@sveltejs/kit";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = () => json({ templates: allTemplates(getApp().store) });

export const POST: RequestHandler = async ({ request }) => {
	const body = await readBody(request, templateInput);

	if (!body.ok) {
		return fail(400, body.error);
	}

	const app = getApp();
	const template: Template = {
		id: crypto.randomUUID(),
		...body.value,
		builtin: false,
		updatedAt: app.now().toISOString(),
	};

	if (findTemplate(app.store, template.name) || !app.store.saveTemplate(template)) {
		return fail(409, `A template named "${template.name}" already exists`);
	}

	return json({ template }, { status: 201 });
};
