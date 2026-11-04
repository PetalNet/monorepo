import { category, doc, field, icon, rect, START, text } from "./build.ts";

const safety = category("safety");

/** A solid header block with a knocked-out icon and heading, then the message in plain ink. */
function header(name: string, heading: string, width: number) {
	return [
		rect("header", { x: 0, y: 0, w: width, h: 70 }),
		icon("icon", { x: START, y: 11, w: 48, h: 48 }, name, { invert: true, stroke: 2.5 }),
		text("heading", { x: 66, y: 12, w: width - 74, h: 46 }, heading, {
			font: "barlow-condensed",
			bold: true,
			invert: true,
			widthMode: "fixed",
		}),
	];
}

export const SAFETY = [
	safety({
		slug: "warning",
		name: "Warning",
		description: "A black warning header with an alert icon, then your message.",
		doc: doc([
			...header("triangle-alert", "WARNING", 196),
			text("message", { x: 206, y: 6, w: 240, h: 58 }, "{{message}}", {
				font: "atkinson",
				bold: true,
			}),
		]),
		fields: [field("message", "Message", "Keep clear", { kind: "multiline" })],
	}),
	safety({
		slug: "do-not-unplug",
		name: "Do not unplug",
		description:
			"A header that stops hands, and the reason underneath, for plugs and power strips.",
		doc: doc([
			...header("unplug", "DO NOT UNPLUG", 280),
			text("reason", { x: 290, y: 6, w: 200, h: 58 }, "{{reason}}", {
				font: "atkinson",
				bold: true,
			}),
		]),
		fields: [field("reason", "Reason", "Server\nrunning", { kind: "multiline" })],
	}),
	safety({
		slug: "hot",
		name: "Hot surface",
		description: "A flame in a solid circle and a large HOT, for kettles, irons and heaters.",
		doc: doc([
			rect("disc", { x: START, y: 3, w: 64, h: 64 }, { shape: "ellipse" }),
			icon("icon", { x: START + 12, y: 15, w: 40, h: 40 }, "flame", { invert: true, stroke: 2.5 }),
			text("heading", { x: 84, y: 4, w: 140, h: 40 }, "HOT", { font: "atkinson", bold: true }),
			text("message", { x: 84, y: 48, w: 200, h: 18 }, "{{message}}", { font: "atkinson" }),
		]),
		fields: [field("message", "Message", "Surface may be hot")],
	}),
	safety({
		slug: "fragile",
		name: "Fragile",
		description: "A heavy border around FRAGILE and a handling note, for boxes and shelves.",
		doc: doc(
			[
				icon("icon", { x: 14, y: 15, w: 40, h: 40 }, "wine", { stroke: 2.5 }),
				text("heading", { x: 62, y: 8, w: 200, h: 36 }, "FRAGILE", {
					font: "barlow-condensed",
					bold: true,
					tracking: 2,
				}),
				text("message", { x: 62, y: 46, w: 200, h: 16 }, "{{message}}", { font: "atkinson" }),
			],
			{ border: { stroke: 4, radius: 0, inset: 0 }, margin: { startMm: 1.5, endMm: 2.5 } },
		),
		fields: [field("message", "Message", "Handle with care")],
	}),
	safety({
		slug: "high-voltage",
		name: "High voltage",
		description:
			"The whole label printed solid with the text knocked out, for panels and enclosures.",
		doc: doc(
			[
				icon("icon", { x: START, y: 11, w: 48, h: 48 }, "zap", { stroke: 2.5 }),
				text("heading", { x: 66, y: 4, w: 240, h: 40 }, "HIGH VOLTAGE", {
					font: "barlow-condensed",
					bold: true,
				}),
				text("message", { x: 66, y: 48, w: 240, h: 18 }, "{{message}}", { font: "atkinson" }),
			],
			{ invert: true, margin: { startMm: 1.5, endMm: 3 } },
		),
		fields: [field("message", "Message", "Authorised access only")],
	}),
];
