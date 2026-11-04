/**
 * Read-only starter templates. Each is plain data built with the small helpers below, laid out in
 * dots for the 70-dot printable band of 12 mm tape.
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

const FONT = "inter";
const UPDATED_AT = "2026-11-04T00:00:00.000Z";

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
		font: FONT,
		size: box.h,
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

export function qr(
	id: string,
	box: Box,
	data: string,
	options: Partial<CodeElement> = {},
): CodeElement {
	return {
		id,
		kind: "code",
		...box,
		rotate: 0,
		invert: false,
		symbology: "qr",
		data,
		ecc: "M",
		showText: false,
		...options,
	};
}

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
		margin: { startMm: 2, endMm: 2 },
		invert: false,
		border: null,
		elements,
		...options,
	};
}

export function field(
	key: string,
	label: string,
	options: Partial<TemplateField> = {},
): TemplateField {
	return { key, label, kind: "text", default: "", ...options };
}

type BuiltinSpec = Omit<Template, "id" | "builtin" | "updatedAt"> & { slug: string };

export function builtin({ slug, ...spec }: BuiltinSpec): Template {
	return { id: `builtin:${slug}`, builtin: true, updatedAt: UPDATED_AT, ...spec };
}

/** Wraps around a cable: the two ends meet back to back as a flag, the middle wraps. */
const FLAG_END = 141;
const FLAG_LENGTH = 425;

export const BUILTIN_TEMPLATES: Template[] = [
	builtin({
		slug: "cable-flag",
		name: "Cable flag",
		category: "lab",
		description: "Wraps around a cable; the text reads on both sides of the flag.",
		doc: doc(
			[
				text("start", { x: 4, y: 4, w: FLAG_END - 8, h: 62 }, "{{label}}", {
					bold: true,
					align: "center",
					widthMode: "fixed",
				}),
				text("end", { x: FLAG_LENGTH - FLAG_END + 4, y: 4, w: FLAG_END - 8, h: 62 }, "{{label}}", {
					bold: true,
					align: "center",
					widthMode: "fixed",
				}),
			],
			{ length: { mode: "fixed", mm: 60 }, margin: { startMm: 0, endMm: 0 } },
		),
		fields: [field("label", "Label", { placeholder: "eth0 to switch 1/12" })],
	}),
	builtin({
		slug: "asset-tag",
		name: "Asset tag",
		category: "lab",
		description: "Asset number and name beside a QR code that opens its record.",
		doc: doc([
			qr("qr", { x: 3, y: 3, w: 64, h: 64 }, "{{url}}"),
			text("asset", { x: 74, y: 3, w: 160, h: 36 }, "{{asset}}", { bold: true }),
			text("name", { x: 74, y: 42, w: 160, h: 25 }, "{{name}}"),
		]),
		fields: [
			field("asset", "Asset number", { placeholder: "A-0042" }),
			field("name", "Name", { placeholder: "Rack server" }),
			field("url", "Link", { kind: "url", placeholder: "https://inventory.example/a/0042" }),
		],
	}),
	builtin({
		slug: "network-port",
		name: "Network port",
		category: "lab",
		description: "A large port number with its VLAN, for patch panels and switches.",
		doc: doc([
			icon("icon", { x: 3, y: 7, w: 56, h: 56 }, "ethernet-port"),
			text("port", { x: 66, y: 2, w: 120, h: 44 }, "{{port}}", { bold: true }),
			text("vlan", { x: 66, y: 48, w: 120, h: 20 }, "VLAN {{vlan}}"),
		]),
		fields: [
			field("port", "Port", { placeholder: "1/12" }),
			field("vlan", "VLAN", { kind: "number", placeholder: "10" }),
		],
	}),
	builtin({
		slug: "storage-bin",
		name: "Storage bin",
		category: "home",
		description: "What a bin or box holds, with a title you can read from across the room.",
		doc: doc([
			icon("icon", { x: 3, y: 7, w: 56, h: 56 }, "package"),
			text("title", { x: 66, y: 2, w: 200, h: 42 }, "{{title}}", { bold: true }),
			text("contents", { x: 66, y: 46, w: 200, h: 22 }, "{{contents}}"),
		]),
		fields: [
			field("title", "Title", { placeholder: "Cables" }),
			field("contents", "Contents", { placeholder: "USB-C, HDMI, adapters" }),
		],
	}),
	builtin({
		slug: "food-date",
		name: "Food and date",
		category: "kitchen",
		description: "What it is and when it was made, for jars and freezer boxes.",
		doc: doc([
			text("item", { x: 3, y: 2, w: 200, h: 44 }, "{{item}}", { bold: true }),
			text("date", { x: 3, y: 48, w: 200, h: 20 }, "{{date}}"),
		]),
		fields: [
			field("item", "Item", { placeholder: "Tomato soup" }),
			field("date", "Date", { kind: "date", default: "{{today}}" }),
		],
	}),
	builtin({
		slug: "warning",
		name: "Warning",
		category: "safety",
		description: "A black warning header with an alert icon, then your message.",
		doc: doc([
			rect("header", { x: 0, y: 0, w: 196, h: 70 }),
			icon("icon", { x: 8, y: 9, w: 52, h: 52 }, "triangle-alert", { invert: true, stroke: 2.5 }),
			text("heading", { x: 64, y: 12, w: 124, h: 46 }, "WARNING", {
				bold: true,
				invert: true,
				widthMode: "fixed",
			}),
			text("message", { x: 204, y: 4, w: 200, h: 62 }, "{{message}}", { bold: true }),
		]),
		fields: [field("message", "Message", { kind: "multiline", placeholder: "High voltage" })],
	}),
];
