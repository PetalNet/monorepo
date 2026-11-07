import type { RenderRequest } from "$lib/api";
import { json } from "@sveltejs/kit";

import type { App } from "./app.ts";
import { pageVars, renderPages, resolveDesign, type Design, type Page } from "./labels.ts";
import { parse, type Parsed, type Parser } from "./parse.ts";
import { LIMITS } from "./schemas.ts";
import { findTemplate } from "./templates.ts";

/** Every API error is `{ error }` with a message a person can act on. */
export const fail = (status: number, error: string): Response => json({ error }, { status });

/** Reads and parses a JSON body. An empty body parses as `{}` when `emptyAsObject`. */
export async function readBody<T>(
	request: Request,
	parser: Parser<T>,
	options: { emptyAsObject?: boolean } = {},
): Promise<Parsed<T>> {
	const tooLarge = `Request body is larger than ${String(LIMITS.bodyBytes / 1024 / 1024)} MB`;

	if (Number(request.headers.get("content-length") ?? 0) > LIMITS.bodyBytes) {
		return { ok: false, error: tooLarge };
	}

	const text = await request.text();

	if (text.length > LIMITS.bodyBytes) {
		return { ok: false, error: tooLarge };
	}

	if (text.trim() === "" && options.emptyAsObject) {
		return parse(parser, {});
	}

	let body: unknown;

	try {
		body = JSON.parse(text);
	} catch {
		return { ok: false, error: "Request body is not valid JSON" };
	}

	return parse(parser, body);
}

export interface Rendered {
	design: Design;
	pages: Page[];
}

/** Resolve the design, merge variables and draw one page per row. */
export async function renderRequestPages(
	app: App,
	request: RenderRequest,
): Promise<{ ok: true; value: Rendered } | { ok: false; response: Response }> {
	const design = resolveDesign(request, (idOrName) => findTemplate(app.store, idOrName));

	if (!design) {
		return {
			ok: false,
			response: fail(404, `No template named "${"template" in request ? request.template : ""}"`),
		};
	}

	if (request.rows?.length === 0) {
		return { ok: false, response: fail(400, "rows is empty; leave it out to print one label") };
	}

	const vars = pageVars(design.template?.fields ?? [], request.vars, request.rows, app.now());

	try {
		return { ok: true, value: { design, pages: await renderPages(design.doc, vars, app.render) } };
	} catch (error) {
		console.error("label-studio: render failed", error);

		return {
			ok: false,
			response: fail(
				500,
				`Could not render the label: ${error instanceof Error ? error.message : String(error)}`,
			),
		};
	}
}

export const pngResponse = (
	png: Uint8Array<ArrayBuffer>,
	headers: Record<string, string> = {},
): Response =>
	new Response(png, {
		headers: { "content-type": "image/png", "cache-control": "no-store", ...headers },
	});
