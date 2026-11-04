import { HEAD_PINS, type Bitmap, type RenderResult } from "$lib/doc";
import { BUILTIN_TEMPLATES } from "$lib/templates/builtin";
import { describe, expect, it } from "vitest";

import { builtinVars, pageVars, renderPages, type Renderer } from "./labels.ts";

const now = new Date(2026, 2, 7, 9, 5);
const food = BUILTIN_TEMPLATES.find((template) => template.id === "builtin:food-date");

describe("pageVars", () => {
	it("provides today and now in local time", () => {
		expect(builtinVars(now)).toEqual({ today: "2026-03-07", now: "2026-03-07 09:05" });
	});

	it("layers built-ins, field defaults, vars and each row", () => {
		const fields = food?.fields ?? [];

		expect(pageVars(fields, { item: "Soup" }, undefined, now)).toEqual([
			{ today: "2026-03-07", now: "2026-03-07 09:05", item: "Soup", date: "2026-03-07" },
		]);

		const pages = pageVars(
			fields,
			{ item: "Soup", today: "override" },
			[{ item: "Chili" }, { date: "2026-04-01" }],
			now,
		);

		expect(pages.map((vars) => [vars.item, vars.date, vars.today])).toEqual([
			["Chili", "2026-03-07", "override"],
			["Soup", "2026-04-01", "override"],
		]);
	});
});

describe("renderPages", () => {
	it("renders one print-mode page per variable set on the document's tape", async () => {
		const calls: { tape: number; mode: string | undefined; label: string | undefined }[] = [];
		const render: Renderer = (doc, options) => {
			calls.push({ tape: options.tape.pins, mode: options.mode, label: options.vars?.label });
			const raster: Bitmap = { width: 20, height: HEAD_PINS, data: new Uint8Array(20 * HEAD_PINS) };
			const result: RenderResult = {
				frame: raster,
				raster,
				lengthDots: 180,
				boxes: {},
				warnings: ["w"],
			};

			return Promise.resolve(result);
		};

		const pages = await renderPages(
			BUILTIN_TEMPLATES[0].doc,
			[{ label: "a" }, { label: "b" }],
			render,
		);

		expect(calls).toEqual([
			{ tape: 70, mode: "print", label: "a" },
			{ tape: 70, mode: "print", label: "b" },
		]);

		expect(pages.map((page) => [page.lengthMm, page.vars.label, page.warnings])).toEqual([
			[25.4, "a", ["w"]],
			[25.4, "b", ["w"]],
		]);

		expect([...pages[0].png.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
	});
});
