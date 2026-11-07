/**
 * Small builders for the read-only gallery. Templates are plain data; these fill in the defaults
 * every element needs so each design reads as just its layout. Coordinates are in dots.
 */
import type {
	Box,
	CodeElement,
	IconElement,
	LabelDoc,
	ShapeElement,
	Template,
	TemplateField,
	TextElement,
} from "$lib/doc";

const UPDATED_AT = "2026-11-04T00:00:00.000Z";

/** Where content starts along the tape, so the first glyph does not sit on the cut. */
export const START = 10;

export function text(
	id: string,
	box: Box,
	value: string,
	options: Partial<TextElement> = {},
): TextElement {
	return {
		id,
		kind: "text",
		...box,
		rotate: 0,
		invert: false,
		text: value,
		font: "inter",
		// With fit "fill" this is only an upper bound; the box height decides the size.
		size: box.h * 2,
		bold: false,
		italic: false,
		align: "left",
		valign: "middle",
		lineHeight: 1.1,
		tracking: 0,
		fit: "fill",
		widthMode: "auto",
		...options,
	};
}

export function icon(
	id: string,
	box: Box,
	name: string,
	options: Partial<IconElement> = {},
): IconElement {
	return { id, kind: "icon", ...box, rotate: 0, invert: false, icon: name, stroke: 2, ...options };
}

export function code(
	id: string,
	box: Box,
	symbology: CodeElement["symbology"],
	data: string,
	options: Partial<CodeElement> = {},
): CodeElement {
	return {
		id,
		kind: "code",
		...box,
		rotate: 0,
		invert: false,
		symbology,
		data,
		ecc: "M",
		showText: symbology !== "qr" && symbology !== "datamatrix",
		...options,
	};
}

export const qr = (
	id: string,
	box: Box,
	data: string,
	options: Partial<CodeElement> = {},
): CodeElement => code(id, box, "qr", data, options);

export function rect(id: string, box: Box, options: Partial<ShapeElement> = {}): ShapeElement {
	return {
		id,
		kind: "shape",
		...box,
		rotate: 0,
		invert: false,
		shape: "rect",
		fill: true,
		stroke: 0,
		radius: 0,
		dashed: false,
		...options,
	};
}

export function doc(elements: LabelDoc["elements"], options: Partial<LabelDoc> = {}): LabelDoc {
	return {
		version: 1,
		tapeMm: 12,
		orientation: "horizontal",
		length: { mode: "auto" },
		margin: { startMm: 1.5, endMm: 2 },
		invert: false,
		border: null,
		elements,
		...options,
	};
}

export function field(
	key: string,
	label: string,
	example: string,
	options: Partial<TemplateField> = {},
): TemplateField {
	return { key, label, kind: "text", default: example, placeholder: example, ...options };
}

/** A date field that defaults to the day the label is printed. */
export const dateField = (key: string, label: string): TemplateField =>
	field(key, label, "{{today}}", { kind: "date", placeholder: "YYYY-MM-DD" });

type BuiltinSpec = Omit<Template, "id" | "builtin" | "updatedAt" | "category"> & { slug: string };

/** Builders for one category's templates, so each design only states what is particular to it. */
export const category =
	(name: Template["category"]) =>
	({ slug, ...spec }: BuiltinSpec): Template => ({
		id: `builtin:${slug}`,
		category: name,
		builtin: true,
		updatedAt: UPDATED_AT,
		...spec,
	});
