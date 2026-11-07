import { category, dateField, doc, field, icon, rect, START, text } from "./build.ts";

const home = category("home");

export const HOME = [
	home({
		slug: "storage-bin",
		name: "Storage bin",
		description: "What a bin or box holds, with a title you can read from across the room.",
		doc: doc([
			icon("icon", { x: START, y: 11, w: 48, h: 48 }, "package"),
			text("title", { x: 68, y: 2, w: 200, h: 44 }, "{{title}}", { bold: true }),
			text("contents", { x: 68, y: 46, w: 200, h: 22 }, "{{contents}}"),
		]),
		fields: [
			field("title", "Title", "Cables"),
			field("contents", "Contents", "USB-C, HDMI, adapters"),
		],
	}),
	home({
		slug: "toolbox-drawer",
		name: "Toolbox drawer",
		description: "A condensed title and the sizes inside, for drawers and organiser bins.",
		doc: doc([
			rect("block", { x: 0, y: 0, w: 70, h: 70 }),
			icon("icon", { x: 13, y: 13, w: 44, h: 44 }, "wrench", { invert: true }),
			text("title", { x: 80, y: 2, w: 200, h: 44 }, "{{title}}", {
				font: "barlow-condensed",
				bold: true,
			}),
			text("sizes", { x: 80, y: 46, w: 200, h: 22 }, "{{sizes}}", { font: "barlow-condensed" }),
		]),
		fields: [field("title", "Title", "Drill bits"), field("sizes", "Sizes", "HSS · 1–10 mm")],
	}),
	home({
		slug: "breaker",
		name: "Breaker",
		description:
			"Circuit number in a block, what it powers, and its rating, for the breaker panel.",
		doc: doc([
			rect("block", { x: 0, y: 0, w: 64, h: 70 }),
			text("circuit", { x: 4, y: 10, w: 56, h: 50 }, "{{circuit}}", {
				font: "barlow-condensed",
				bold: true,
				align: "center",
				invert: true,
				widthMode: "fixed",
			}),
			text("area", { x: 74, y: 2, w: 200, h: 44 }, "{{area}}", {
				font: "barlow-condensed",
				bold: true,
			}),
			text("rating", { x: 74, y: 46, w: 200, h: 22 }, "{{rating}}", { font: "barlow-condensed" }),
		]),
		fields: [
			field("circuit", "Circuit", "12"),
			field("area", "Powers", "Kitchen outlets"),
			field("rating", "Rating", "20 A · GFCI"),
		],
	}),
	home({
		slug: "outlet-switch",
		name: "Outlet or switch",
		description: "A small label for a cover plate: what it controls and which breaker feeds it.",
		doc: doc([
			icon("icon", { x: START, y: 13, w: 44, h: 44 }, "zap"),
			text("what", { x: 64, y: 2, w: 160, h: 44 }, "{{what}}", { bold: true }),
			text("circuit", { x: 64, y: 46, w: 160, h: 22 }, "Breaker {{circuit}}"),
		]),
		fields: [field("what", "Controls", "Porch light"), field("circuit", "Breaker", "7")],
	}),
	home({
		slug: "keys",
		name: "Key tag",
		description: "Which door or lock a key opens, short enough for a key tag.",
		doc: doc([
			icon("icon", { x: START, y: 15, w: 40, h: 40 }, "key-round"),
			text("name", { x: 58, y: 2, w: 160, h: 44 }, "{{name}}", { font: "atkinson", bold: true }),
			text("note", { x: 58, y: 46, w: 160, h: 22 }, "{{note}}", { font: "atkinson" }),
		]),
		fields: [field("name", "Opens", "Shed"), field("note", "Note", "Spare · padlock")],
	}),
	home({
		slug: "charger",
		name: "Charger",
		description:
			"Which device a charger or adapter belongs to, with its output, so it finds its way home.",
		doc: doc([
			icon("icon", { x: START, y: 13, w: 44, h: 44 }, "plug-zap"),
			text("device", { x: 64, y: 2, w: 200, h: 44 }, "{{device}}", { bold: true }),
			text("output", { x: 64, y: 46, w: 200, h: 22 }, "{{output}}"),
		]),
		fields: [field("device", "Device", "Laptop"), field("output", "Output", "USB-C · 20 V 3.25 A")],
	}),
	home({
		slug: "replaced-on",
		name: "Replaced on",
		description: "When a filter, battery or bulb was last changed, and when it is next due.",
		doc: doc([
			icon("icon", { x: START, y: 13, w: 44, h: 44 }, "refresh-cw"),
			text("item", { x: 64, y: 2, w: 200, h: 44 }, "{{item}}", { bold: true }),
			text("dates", { x: 64, y: 46, w: 240, h: 22 }, "Replaced {{date}} · next {{next}}"),
		]),
		fields: [
			field("item", "Item", "Air filter"),
			dateField("date", "Replaced"),
			field("next", "Next due", "2027-02"),
		],
	}),
	home({
		slug: "paint-can",
		name: "Paint can",
		description:
			"Colour name and code, the room it went on and when, so touch-ups match. Laid out for 18 mm tape.",
		doc: doc(
			[
				icon("icon", { x: START, y: 26, w: 60, h: 60 }, "paint-bucket"),
				text("colour", { x: 84, y: 6, w: 280, h: 50 }, "{{colour}}", { bold: true }),
				text("code", { x: 84, y: 60, w: 280, h: 22 }, "{{code}} · {{finish}}"),
				text("where", { x: 84, y: 86, w: 280, h: 20 }, "{{room}} · {{date}}"),
			],
			{ tapeMm: 18 },
		),
		fields: [
			field("colour", "Colour", "Harbour Blue"),
			field("code", "Code", "No. 1234"),
			field("finish", "Finish", "Eggshell"),
			field("room", "Room", "Living room"),
			dateField("date", "Painted"),
		],
	}),
];
