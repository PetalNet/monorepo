import type { DesignRef } from "$lib/api";
import {
	dotsToMm,
	interpolate,
	tapeGeometry,
	type LabelDoc,
	type RenderOptions,
	type RenderResult,
	type Template,
	type TemplateField,
	type Vars,
} from "$lib/doc";

import { encodePng } from "./png.ts";

/** `renderLabel` with its fonts bound; injected so tests can draw without fonts. */
export type Renderer = (doc: LabelDoc, options: RenderOptions) => Promise<RenderResult>;

export interface Page {
	png: Uint8Array<ArrayBuffer>;
	lengthDots: number;
	lengthMm: number;
	vars: Vars;
	warnings: string[];
}

export interface Design {
	doc: LabelDoc;
	template: Template | null;
}

const pad = (value: number): string => String(value).padStart(2, "0");

/** `today` (YYYY-MM-DD) and `now` (YYYY-MM-DD HH:MM) in the server's local time. */
export function builtinVars(now: Date): Vars {
	const today = `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

	return { today, now: `${today} ${pad(now.getHours())}:${pad(now.getMinutes())}` };
}

/**
 * One variable set per page: built-ins, under field defaults, under `vars`, under each row.
 * Defaults may use built-ins, so a date field can default to "{{today}}".
 */
export function pageVars(
	fields: readonly TemplateField[],
	vars: Vars | undefined,
	rows: readonly Vars[] | undefined,
	now: Date,
): Vars[] {
	const builtins = builtinVars(now);
	const defaults = Object.fromEntries(
		fields.map((field) => [field.key, interpolate(field.default, builtins)]),
	);
	const shared = { ...builtins, ...defaults, ...vars };

	return rows === undefined ? [shared] : rows.map((row) => ({ ...shared, ...row }));
}

export function resolveDesign(
	ref: DesignRef,
	findTemplate: (idOrName: string) => Template | null,
): Design | null {
	if ("doc" in ref) {
		return { doc: ref.doc, template: null };
	}

	const template = findTemplate(ref.template);

	return template ? { doc: template.doc, template } : null;
}

export async function renderPages(
	doc: LabelDoc,
	varsList: readonly Vars[],
	render: Renderer,
): Promise<Page[]> {
	const tape = tapeGeometry(doc.tapeMm);

	return Promise.all(
		varsList.map(async (vars) => {
			const result = await render(doc, { tape, vars, mode: "print" });

			if (!result.raster) {
				throw new Error("The renderer returned no printer raster");
			}

			return {
				png: encodePng(result.raster),
				lengthDots: result.lengthDots,
				lengthMm: roundMm(dotsToMm(result.lengthDots)),
				vars,
				warnings: result.warnings,
			};
		}),
	);
}

export const roundMm = (mm: number): number => Math.round(mm * 10) / 10;

/** Default job title: the template name, else the first text element's first line. */
export function defaultTitle(design: Design, vars: Vars): string {
	if (design.template) {
		return design.template.name;
	}

	for (const element of design.doc.elements) {
		if (element.kind === "text") {
			const line = interpolate(element.text, vars).split("\n")[0].trim();

			if (line) {
				return line.slice(0, 80);
			}
		}
	}

	return "Label";
}
