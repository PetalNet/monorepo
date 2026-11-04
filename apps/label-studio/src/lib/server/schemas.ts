import type { DesignRef, PrintRequest, RenderRequest, TemplateInput } from "$lib/api";
import {
	isTapeWidth,
	type LabelDoc,
	type LabelElement,
	type TapeWidthMm,
	type TemplateCategory,
	type TemplateField,
	type Vars,
} from "$lib/doc";

import {
	array,
	boolean,
	nullable,
	number,
	object,
	oneOf,
	optional,
	record,
	refine,
	string,
	tagged,
	type Parser,
} from "./parse.ts";

export const LIMITS = {
	rows: 200,
	copies: 99,
	elements: 200,
	fields: 50,
	/** Request bodies, which carry images as base64 luminance. */
	bodyBytes: 8 * 1024 * 1024,
	imagePixels: 2048 * 2048,
} as const;

const dots = number({ min: -100_000, max: 100_000 });

const tapeWidth: Parser<TapeWidthMm> = (input, path) =>
	isTapeWidth(input)
		? { ok: true, value: input }
		: { ok: false, error: `${path}: expected a tape width of 4, 6, 9, 12, 18 or 24 mm` };

const base = {
	id: string({ min: 1, max: 64 }),
	x: dots,
	y: dots,
	w: number({ min: 0, max: 100_000 }),
	h: number({ min: 0, max: 100_000 }),
	rotate: oneOf(0, 90, 180, 270),
	invert: boolean,
	locked: optional(boolean),
	name: optional(string({ max: 120 })),
};

const text = object({
	...base,
	kind: oneOf("text"),
	text: string({ max: 4000 }),
	font: string({ min: 1, max: 80 }),
	size: number({ min: 1, max: 2000 }),
	bold: boolean,
	italic: boolean,
	align: oneOf("left", "center", "right"),
	valign: oneOf("top", "middle", "bottom"),
	lineHeight: number({ min: 0.1, max: 10 }),
	tracking: number({ min: -200, max: 200 }),
	fit: oneOf("fill", "shrink", "fixed"),
	widthMode: oneOf("fixed", "auto"),
});

const icon = object({
	...base,
	kind: oneOf("icon"),
	icon: string({ min: 1, max: 80, pattern: /^[a-z0-9-]+$/ }),
	stroke: number({ min: 0.1, max: 24 }),
});

const shape = object({
	...base,
	kind: oneOf("shape"),
	shape: oneOf("rect", "ellipse", "line-h", "line-v"),
	fill: boolean,
	stroke: number({ min: 0, max: 1000 }),
	radius: number({ min: 0, max: 10_000 }),
	dashed: boolean,
});

const image = refine(
	object({
		...base,
		kind: oneOf("image"),
		gray: string({ max: Math.ceil(LIMITS.imagePixels / 3) * 4 }),
		srcW: number({ min: 1, max: 2048, integer: true }),
		srcH: number({ min: 1, max: 2048, integer: true }),
		mode: oneOf("threshold", "dither"),
		threshold: number({ min: 0, max: 255 }),
		fit: oneOf("contain", "cover", "stretch"),
	}),
	(value) =>
		Buffer.from(value.gray, "base64").length === value.srcW * value.srcH
			? null
			: `gray must hold srcW × srcH (${String(value.srcW * value.srcH)}) bytes`,
);

const code = object({
	...base,
	kind: oneOf("code"),
	symbology: oneOf("qr", "code128", "datamatrix", "ean13"),
	data: string({ max: 2000 }),
	ecc: oneOf("L", "M", "Q", "H"),
	showText: boolean,
});

const element: Parser<LabelElement> = tagged("kind", { text, icon, shape, image, code });

const labelDoc: Parser<LabelDoc> = refine(
	object({
		version: oneOf(1),
		tapeMm: tapeWidth,
		orientation: oneOf("horizontal", "vertical"),
		length: tagged("mode", {
			auto: object({ mode: oneOf("auto") }),
			fixed: object({ mode: oneOf("fixed"), mm: number({ min: 1, max: 1000 }) }),
		}),
		margin: object({
			startMm: number({ min: 0, max: 200 }),
			endMm: number({ min: 0, max: 200 }),
		}),
		invert: boolean,
		border: nullable(
			object({
				stroke: number({ min: 0, max: 200 }),
				radius: number({ min: 0, max: 1000 }),
				inset: number({ min: 0, max: 200 }),
			}),
		),
		elements: array(element, { max: LIMITS.elements }),
	}),
	(doc) => {
		const ids = new Set<string>();

		for (const item of doc.elements) {
			if (ids.has(item.id)) {
				return `element id "${item.id}" is used twice`;
			}

			ids.add(item.id);
		}

		return null;
	},
);

const VAR_KEY = /^[\w.-]{1,64}$/;

const vars: Parser<Vars> = refine(record(string({ max: 4000 }), { maxKeys: 100 }), (value) => {
	const bad = Object.keys(value).find((key) => !VAR_KEY.test(key));

	return bad === undefined ? null : `"${bad}" is not a valid variable name`;
});

const CATEGORIES = [
	"lab",
	"home",
	"kitchen",
	"office",
	"school",
	"safety",
	"garden",
	"personal",
	"qr",
] as const satisfies readonly TemplateCategory[];

const field: Parser<TemplateField> = object({
	key: string({ pattern: VAR_KEY }),
	label: string({ min: 1, max: 80 }),
	kind: oneOf("text", "multiline", "date", "number", "url"),
	default: string({ max: 4000 }),
	placeholder: optional(string({ max: 200 })),
});

export const templateInput: Parser<TemplateInput> = object({
	name: string({ min: 1, max: 80 }),
	category: oneOf(...CATEGORIES),
	description: string({ max: 500 }),
	doc: labelDoc,
	fields: refine(array(field, { max: LIMITS.fields }), (fields) => {
		const keys = fields.map((item) => item.key);
		const repeated = keys.find((key, index) => keys.indexOf(key) !== index);

		return repeated === undefined ? null : `field "${repeated}" is defined twice`;
	}),
});

const renderShape = {
	doc: optional(labelDoc),
	template: optional(string({ min: 1, max: 120 })),
	vars: optional(vars),
	rows: optional(array(vars, { max: LIMITS.rows })),
};

function designRef(value: { doc?: LabelDoc; template?: string }): DesignRef | string {
	if (value.doc && value.template === undefined) {
		return { doc: value.doc };
	}

	if (value.template !== undefined && !value.doc) {
		return { template: value.template };
	}

	return "give exactly one of doc or template";
}

function withDesign<T extends { doc?: LabelDoc; template?: string }, R>(
	parser: Parser<T>,
	build: (value: T, design: DesignRef) => R,
): Parser<R> {
	return (input, path) => {
		const parsed = parser(input, path);

		if (!parsed.ok) {
			return parsed;
		}

		const design = designRef(parsed.value);

		return typeof design === "string"
			? { ok: false, error: design }
			: { ok: true, value: build(parsed.value, design) };
	};
}

export const renderRequest: Parser<RenderRequest> = withDesign(
	object(renderShape),
	(value, design) => ({ ...design, vars: value.vars, rows: value.rows }),
);

export const printRequest: Parser<PrintRequest> = refine(
	withDesign(
		object({
			...renderShape,
			copies: optional(number({ min: 1, max: LIMITS.copies, integer: true })),
			cut: optional(boolean),
			chain: optional(boolean),
			dryRun: optional(boolean),
			title: optional(string({ max: 120 })),
		}),
		(value, design) => ({
			...design,
			vars: value.vars,
			rows: value.rows,
			copies: value.copies,
			cut: value.cut,
			chain: value.chain,
			dryRun: value.dryRun,
			title: value.title,
		}),
	),
	(value) =>
		"doc" in value && value.doc.elements.length === 0 ? "doc: has nothing to print" : null,
);

export const reprintRequest = object({
	copies: optional(number({ min: 1, max: LIMITS.copies, integer: true })),
	dryRun: optional(boolean),
});
