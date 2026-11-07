import { BUILTIN_TEMPLATES } from "$lib/templates/builtin";
import { describe, expect, it } from "vitest";

import { parse } from "./parse.ts";
import { printRequest, renderRequest, templateInput } from "./schemas.ts";

const doc = BUILTIN_TEMPLATES[1].doc;

describe("request schemas", () => {
	it("accepts a template reference or an inline document, not both", () => {
		expect(parse(renderRequest, { template: "Asset tag", vars: { asset: "A-1" } })).toEqual({
			ok: true,
			value: { template: "Asset tag", vars: { asset: "A-1" }, rows: undefined },
		});

		expect(parse(renderRequest, { doc })).toMatchObject({ ok: true, value: { doc } });

		expect(parse(renderRequest, { doc, template: "x" })).toEqual({
			ok: false,
			error: "give exactly one of doc or template",
		});

		expect(parse(renderRequest, {})).toMatchObject({ ok: false });
	});

	it("names the path of the first problem", () => {
		const broken = structuredClone(doc);

		Object.assign(broken.elements[1], { size: "big" });

		expect(parse(renderRequest, { doc: broken })).toEqual({
			ok: false,
			error: "doc.elements[1].size: expected a number",
		});

		expect(parse(renderRequest, { doc: { ...doc, tapeMm: 10 } })).toEqual({
			ok: false,
			error: "doc.tapeMm: expected a tape width of 4, 6, 9, 12, 18 or 24 mm",
		});

		expect(
			parse(renderRequest, { doc: { ...doc, elements: [{ ...doc.elements[0], kind: "blob" }] } }),
		).toEqual({
			ok: false,
			error: 'doc.elements[0].kind: expected one of "text", "icon", "shape", "image", "code"',
		});
	});

	it("enforces copy and row limits", () => {
		expect(parse(printRequest, { template: "x", copies: 100 })).toEqual({
			ok: false,
			error: "copies: must be at most 99",
		});

		expect(parse(printRequest, { template: "x", copies: 1.5 })).toMatchObject({ ok: false });

		expect(
			parse(printRequest, { template: "x", rows: Array.from({ length: 201 }, () => ({})) }),
		).toEqual({
			ok: false,
			error: "rows: at most 200 items",
		});

		expect(parse(printRequest, { template: "x", vars: { "bad key": "1" } })).toEqual({
			ok: false,
			error: 'vars: "bad key" is not a valid variable name',
		});
	});

	it("refuses to print a document with nothing on it", () => {
		expect(parse(printRequest, { doc: { ...doc, elements: [] } })).toEqual({
			ok: false,
			error: "doc: has nothing to print",
		});

		expect(parse(printRequest, { doc })).toMatchObject({ ok: true, value: { doc } });
		expect(parse(renderRequest, { doc: { ...doc, elements: [] } })).toMatchObject({ ok: true });
	});

	it("checks an image's pixel data matches its size", () => {
		const image = {
			id: "img",
			kind: "image",
			x: 0,
			y: 0,
			w: 10,
			h: 10,
			rotate: 0,
			invert: false,
			gray: Buffer.alloc(6).toString("base64"),
			srcW: 2,
			srcH: 3,
			mode: "dither",
			threshold: 128,
			fit: "contain",
		};

		expect(parse(renderRequest, { doc: { ...doc, elements: [image] } })).toMatchObject({
			ok: true,
		});

		expect(parse(renderRequest, { doc: { ...doc, elements: [{ ...image, srcH: 4 }] } })).toEqual({
			ok: false,
			error: "doc.elements[0]: gray must hold srcW × srcH (8) bytes",
		});
	});

	it("rejects duplicate element ids and field keys", () => {
		const twice = { ...doc, elements: [doc.elements[0], doc.elements[0]] };

		expect(parse(renderRequest, { doc: twice })).toEqual({
			ok: false,
			error: 'doc: element id "qr" is used twice',
		});

		const template = BUILTIN_TEMPLATES[1];

		expect(
			parse(templateInput, { ...template, fields: [template.fields[0], template.fields[0]] }),
		).toEqual({ ok: false, error: 'fields: field "asset" is defined twice' });
	});

	it("drops unknown keys so stored documents stay canonical", () => {
		const parsed = parse(templateInput, { ...BUILTIN_TEMPLATES[0], extra: 1 });

		expect(parsed.ok && Object.keys(parsed.value)).toEqual([
			"name",
			"category",
			"description",
			"doc",
			"fields",
		]);
	});
});
