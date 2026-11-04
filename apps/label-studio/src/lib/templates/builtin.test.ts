import { interpolate, mmToDots, placeholders, tapeGeometry, type Template } from "$lib/doc";
import { renderLabel } from "$lib/render";
import { serverFonts } from "$lib/server/fonts";
import { pageVars } from "$lib/server/labels";
import { parse } from "$lib/server/parse";
import { templateInput } from "$lib/server/schemas";
import { describe, expect, it } from "vitest";

import { BUILTIN_TEMPLATES } from "./builtin.ts";
import { wifiJoin } from "./qr-data.ts";

const BUILTIN_VARS = new Set(["today", "now"]);
const NOW = new Date("2026-03-07T09:05:00");
const each = BUILTIN_TEMPLATES.map((template) => [template.id, template] as const);

const defaults = (template: Template) => pageVars(template.fields, undefined, undefined, NOW)[0];

describe("BUILTIN_TEMPLATES", () => {
	it.each(each)("%s is a valid template whose placeholders all have fields", (_id, template) => {
		expect(parse(templateInput, template)).toMatchObject({ ok: true });
		const fields = new Set(template.fields.map((item) => item.key));
		const missing = placeholders(template.doc).filter(
			(key) => !fields.has(key) && !BUILTIN_VARS.has(key),
		);

		expect(missing).toEqual([]);
		expect(template.id.startsWith("builtin:")).toBe(true);
	});

	it.each(each)("%s has an example value in every field", (_id, template) => {
		const empty = template.fields.filter(
			(item) => interpolate(item.default, defaults(template)) === "",
		);

		expect(empty.map((item) => item.key)).toEqual([]);
	});

	it.each(each)("%s renders its defaults cleanly inside the label", async (_id, template) => {
		const { doc } = template;
		const tape = tapeGeometry(doc.tapeMm);
		const result = await renderLabel(
			doc,
			{ tape, vars: defaults(template), mode: "print" },
			serverFonts,
		);
		const vertical = doc.orientation === "vertical";
		const [frameW, frameH] = vertical
			? [tape.pins, result.lengthDots]
			: [result.lengthDots, tape.pins];

		expect(result.warnings).toEqual([]);

		if (doc.length.mode === "fixed") {
			expect(result.lengthDots).toBe(mmToDots(doc.length.mm));
		}

		for (const [id, box] of Object.entries(result.boxes)) {
			const where = `${template.id}/${id}`;

			expect(box.x, where).toBeGreaterThanOrEqual(0);
			expect(box.y, where).toBeGreaterThanOrEqual(0);
			expect(box.x + box.w, where).toBeLessThanOrEqual(frameW);
			expect(box.y + box.h, where).toBeLessThanOrEqual(frameH);
		}

		expect(result.raster?.data.some((value) => value === 255)).toBe(true);
	});

	it("covers every category with a gallery of 35 to 45 templates", () => {
		const categories = new Set(BUILTIN_TEMPLATES.map((template) => template.category));

		expect(BUILTIN_TEMPLATES.length).toBeGreaterThanOrEqual(35);
		expect(BUILTIN_TEMPLATES.length).toBeLessThanOrEqual(45);

		expect([...categories].toSorted()).toEqual([
			"garden",
			"home",
			"kitchen",
			"lab",
			"office",
			"personal",
			"qr",
			"safety",
			"school",
		]);
	});

	it("has unique ids and names", () => {
		const names = BUILTIN_TEMPLATES.map((template) => template.name.toLowerCase());

		expect(new Set(names).size).toBe(names.length);
		expect(new Set(BUILTIN_TEMPLATES.map((template) => template.id)).size).toBe(names.length);
	});

	it.each([
		["builtin:proxmox-guest", ["vmid", "name", "type"]],
		["builtin:drive-tag", ["name", "serial", "model", "size"]],
		["builtin:hass-entity", ["name", "entity_id"]],
	])("%s uses its source's column keys, so batch rows need no mapping", (id, columns) => {
		const template = BUILTIN_TEMPLATES.find((item) => item.id === id);

		expect(template && placeholders(template.doc).toSorted()).toEqual(columns.toSorted());
	});

	it("joins Wi-Fi with the network and password the fields hold", () => {
		const template = BUILTIN_TEMPLATES.find((item) => item.id === "builtin:wifi-qr");
		const qr = template?.doc.elements.find((element) => element.kind === "code");
		const vars = { ssid: "Cabin", password: "pine-cone-7" };

		expect(qr && interpolate(qr.data, vars)).toBe(wifiJoin(vars.ssid, vars.password));
	});
});
