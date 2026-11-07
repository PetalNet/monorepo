import type { Template } from "$lib/doc";
import { getApp } from "$lib/server/app";
import { fail, readBody } from "$lib/server/http";
import { templateInput } from "$lib/server/schemas";
import { findTemplate, isBuiltinId } from "$lib/server/templates";
import { BUILTIN_TEMPLATES } from "$lib/templates/builtin";
import { json } from "@sveltejs/kit";

import type { RequestHandler } from "./$types";

const READ_ONLY = "Built-in templates are read-only; save a copy to change it";

/** `id` may also be a template name, case-insensitive. */
export const GET: RequestHandler = ({ params }) => {
	const template = findTemplate(getApp().store, params.id);

	return template ? json({ template }) : fail(404, `No template named "${params.id}"`);
};

export const PUT: RequestHandler = async ({ params, request }) => {
	if (isBuiltinId(params.id)) {
		return fail(409, READ_ONLY);
	}

	const body = await readBody(request, templateInput);

	if (!body.ok) {
		return fail(400, body.error);
	}

	const app = getApp();
	const existing = app.store.findTemplate(params.id);

	if (existing?.id !== params.id) {
		return fail(404, "No such template");
	}

	const template: Template = {
		...body.value,
		id: params.id,
		builtin: false,
		updatedAt: app.now().toISOString(),
	};
	const lower = template.name.toLowerCase();

	if (
		BUILTIN_TEMPLATES.some((item) => item.name.toLowerCase() === lower) ||
		!app.store.saveTemplate(template)
	) {
		return fail(409, `A template named "${template.name}" already exists`);
	}

	return json({ template });
};

export const DELETE: RequestHandler = ({ params }) => {
	if (isBuiltinId(params.id)) {
		return fail(409, READ_ONLY);
	}

	return getApp().store.deleteTemplate(params.id)
		? new Response(null, { status: 204 })
		: fail(404, "No such template");
};
