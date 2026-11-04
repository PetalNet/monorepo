import { placeholders } from "$lib/doc";
import { parse } from "$lib/server/parse";
import { templateInput } from "$lib/server/schemas";
import { describe, expect, it } from "vitest";

import { BUILTIN_TEMPLATES } from "./builtin.ts";

const BUILTIN_VARS = new Set(["today", "now"]);

describe("BUILTIN_TEMPLATES", () => {
	it.each(BUILTIN_TEMPLATES.map((template) => [template.id, template] as const))(
		"%s is a valid template whose placeholders all have fields",
		(_id, template) => {
			expect(parse(templateInput, template)).toMatchObject({ ok: true });
			const fields = new Set(template.fields.map((item) => item.key));
			const missing = placeholders(template.doc).filter(
				(key) => !fields.has(key) && !BUILTIN_VARS.has(key),
			);

			expect(missing).toEqual([]);
			expect(template.id.startsWith("builtin:")).toBe(true);
		},
	);

	it("keeps every element inside the 12 mm band", () => {
		for (const template of BUILTIN_TEMPLATES) {
			for (const element of template.doc.elements) {
				expect(element.y, `${template.id}/${element.id}`).toBeGreaterThanOrEqual(0);
				expect(element.y + element.h, `${template.id}/${element.id}`).toBeLessThanOrEqual(70);
			}
		}
	});

	it("has unique ids and names", () => {
		const names = BUILTIN_TEMPLATES.map((template) => template.name.toLowerCase());

		expect(new Set(names).size).toBe(names.length);
		expect(new Set(BUILTIN_TEMPLATES.map((template) => template.id)).size).toBe(names.length);
	});
});
