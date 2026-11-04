/**
 * The label document: the one shape the editor edits, templates store, the
 * renderer draws and the print API accepts. Every length is in printer dots
 * (180 dpi) unless its name ends in `Mm`.
 */

export const DPI = 180;
export const DOTS_PER_MM = DPI / 25.4;
/** Pins on the PT-P710BT print head; every raster sent to the printer is this tall. */
export const HEAD_PINS = 128;

/**
 * Printable pins and the offset of the first printable pin, per tape width, from
 * Brother's raster command reference (pp. 14 and 20). "4" is the 3.5 mm tape,
 * which the printer reports as 4.
 */
export const TAPES = {
	4: { pins: 24, margin: 52 },
	6: { pins: 32, margin: 48 },
	9: { pins: 50, margin: 39 },
	12: { pins: 70, margin: 29 },
	18: { pins: 112, margin: 8 },
	24: { pins: 128, margin: 0 },
} as const;

export type TapeWidthMm = keyof typeof TAPES;
export const TAPE_WIDTHS = Object.keys(TAPES).map(Number) as TapeWidthMm[];

export interface TapeGeometry {
	widthMm: TapeWidthMm;
	/** Printable band height in dots. */
	pins: number;
	/** First printable pin; the band occupies raster rows [margin, margin + pins). */
	margin: number;
}

export function tapeGeometry(widthMm: TapeWidthMm): TapeGeometry {
	return { widthMm, ...TAPES[widthMm] };
}

export function isTapeWidth(value: unknown): value is TapeWidthMm {
	return typeof value === "number" && value in TAPES;
}

export const mmToDots = (mm: number): number => Math.round(mm * DOTS_PER_MM);
export const dotsToMm = (dots: number): number => dots / DOTS_PER_MM;

/**
 * The design frame. In "horizontal" orientation it is `length × pins` and x runs
 * along the tape. In "vertical" orientation it is `pins × length`: the user designs
 * a portrait strip and the renderer rotates it 90° counter-clockwise onto the tape,
 * so frame (x, y) lands on tape (y, pins - 1 - x) and the frame's top edge is the
 * start of the label.
 */
export type Orientation = "horizontal" | "vertical";

export type LabelLength = { mode: "auto" } | { mode: "fixed"; mm: number };

export type Rotation = 0 | 90 | 180 | 270;

/**
 * Position and footprint in the design frame, in dots. For rotate 90/270 the box is
 * the on-canvas footprint after rotation, so the content is laid out in an `h × w`
 * local box and then turned. Handles and hit tests always use the box as stored.
 */
export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

interface ElementBase extends Box {
	id: string;
	rotate: Rotation;
	/** Fill the box with ink and draw the content in paper colour (white on black). */
	invert: boolean;
	locked?: boolean;
	/** Editor-facing name for the layers list. */
	name?: string;
}

export type FontId = string;
export type TextAlign = "left" | "center" | "right";
export type VerticalAlign = "top" | "middle" | "bottom";
/**
 * "fill": the largest size at which every line fits the box (the label-maker default).
 * "shrink": use `size`, but shrink until it fits. "fixed": use `size` and clip.
 */
export type TextFit = "fill" | "shrink" | "fixed";

export interface TextElement extends ElementBase {
	kind: "text";
	/** May contain `{{var}}` placeholders and `\n` line breaks. */
	text: string;
	font: FontId;
	/** Em size in dots. With fit "fill" this is the upper bound. */
	size: number;
	bold: boolean;
	italic: boolean;
	align: TextAlign;
	valign: VerticalAlign;
	/** Line advance as a multiple of the em size. */
	lineHeight: number;
	/** Extra advance between glyphs, in dots. */
	tracking: number;
	fit: TextFit;
	/**
	 * "auto": the box width follows the laid-out text (useful with auto length);
	 * the renderer reports the resolved width in `RenderResult.boxes`.
	 */
	widthMode: "fixed" | "auto";
}

export interface IconElement extends ElementBase {
	kind: "icon";
	/** Lucide icon name in kebab case, e.g. "triangle-alert". */
	icon: string;
	/** Stroke width on Lucide's 24-unit grid (Lucide's default is 2). */
	stroke: number;
}

export type ShapeKind = "rect" | "ellipse" | "line-h" | "line-v";

export interface ShapeElement extends ElementBase {
	kind: "shape";
	shape: ShapeKind;
	fill: boolean;
	/** Outline width in dots; 0 draws no outline. Lines use it as their thickness. */
	stroke: number;
	/** Corner radius in dots (rect only). */
	radius: number;
	dashed: boolean;
}

export type ImageMode = "threshold" | "dither";
export type ImageFit = "contain" | "cover" | "stretch";

export interface ImageElement extends ElementBase {
	kind: "image";
	/** Source luminance, one byte per pixel (0 black, 255 white), base64, row-major. */
	gray: string;
	srcW: number;
	srcH: number;
	mode: ImageMode;
	/** 0–255; luminance below this prints (threshold mode) or biases the dither. */
	threshold: number;
	fit: ImageFit;
}

export type Symbology = "qr" | "code128" | "datamatrix" | "ean13";

export interface CodeElement extends ElementBase {
	kind: "code";
	symbology: Symbology;
	/** May contain `{{var}}` placeholders. */
	data: string;
	/** QR error correction. */
	ecc: "L" | "M" | "Q" | "H";
	/** Print human-readable text under 1D codes. */
	showText: boolean;
}

export type LabelElement = TextElement | IconElement | ShapeElement | ImageElement | CodeElement;
export type ElementKind = LabelElement["kind"];

export interface Border {
	/** Line width in dots. */
	stroke: number;
	/** Corner radius in dots. */
	radius: number;
	/** Distance from the band edge in dots. */
	inset: number;
}

export interface LabelDoc {
	version: 1;
	/** The tape width this design was laid out for. Printing checks it against the loaded tape. */
	tapeMm: TapeWidthMm;
	orientation: Orientation;
	length: LabelLength;
	/**
	 * Blank tape before and after the content, along the tape. Element positions are
	 * never shifted: with auto length the label ends `endMm` after the furthest element
	 * edge, and `startMm` is the guide the editor snaps new and dragged content to.
	 * With fixed length both are layout guides.
	 */
	margin: { startMm: number; endMm: number };
	/** Print the whole band as ink with the design knocked out. */
	invert: boolean;
	border: Border | null;
	/** Painted in order: index 0 is the bottom layer. */
	elements: LabelElement[];
}

/** A `{{var}}` field a template exposes. */
export interface TemplateField {
	key: string;
	label: string;
	kind: "text" | "multiline" | "date" | "number" | "url";
	default: string;
	placeholder?: string;
}

export type TemplateCategory =
	| "lab"
	| "home"
	| "kitchen"
	| "office"
	| "school"
	| "safety"
	| "garden"
	| "personal"
	| "qr";

export interface Template {
	id: string;
	name: string;
	category: TemplateCategory;
	description: string;
	doc: LabelDoc;
	fields: TemplateField[];
	builtin: boolean;
	updatedAt: string;
}

export type Vars = Readonly<Record<string, string>>;

const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** Replace `{{key}}` with `vars[key]`. Unknown keys render as empty strings. */
export function interpolate(value: string, vars: Vars): string {
	return value.replaceAll(PLACEHOLDER, (_, key: string) => vars[key] ?? "");
}

/** Every distinct `{{key}}` used by a document's text and code elements, in first-use order. */
export function placeholders(doc: LabelDoc): string[] {
	const keys = new Set<string>();
	for (const element of doc.elements) {
		const source =
			element.kind === "text" ? element.text : element.kind === "code" ? element.data : "";
		for (const match of source.matchAll(PLACEHOLDER)) {
			keys.add(match[1]);
		}
	}
	return [...keys];
}

/** A 1-bit or grayscale raster. `data[y * width + x]` is ink: 0 paper, 255 full ink. */
export interface Bitmap {
	width: number;
	height: number;
	data: Uint8Array;
}

export interface RenderOptions {
	tape: TapeGeometry;
	vars?: Vars;
	/**
	 * "print": exactly what the printer will burn, values 0 or 255 only, 1 dot per pixel.
	 * "design": the same geometry for the editor, drawn at `scale` pixels per dot, with
	 * images in grayscale instead of thresholded or dithered.
	 */
	mode?: "print" | "design";
	/** Integer pixels per dot in design mode. Print mode always uses 1. */
	scale?: number;
}

export interface RenderResult {
	/** The design frame (`frameW × frameH` in dots, times `scale` in design mode), before orientation. */
	frame: Bitmap;
	/** Print mode only: the HEAD_PINS-high raster for the printer, band placed at tape.margin. */
	raster: Bitmap | null;
	/** Label length along the tape, in dots. */
	lengthDots: number;
	/** Resolved boxes per element id (auto-width text reports its laid-out width). */
	boxes: Record<string, Box>;
	/** Non-fatal problems a user should see, e.g. "EAN-13 needs 12 or 13 digits". */
	warnings: string[];
}
