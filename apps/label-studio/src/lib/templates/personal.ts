import { category, doc, field, icon, rect, text } from "./build.ts";

const personal = category("personal");

export const PERSONAL = [
	personal({
		slug: "if-found",
		name: "If found",
		description:
			"Return-if-found contact details behind a clear header, for laptops, cases and cameras.",
		doc: doc([
			rect("header", { x: 0, y: 0, w: 112, h: 70 }),
			text("lead", { x: 6, y: 8, w: 100, h: 54 }, "IF FOUND\nplease contact", {
				bold: true,
				align: "center",
				invert: true,
				widthMode: "fixed",
				lineHeight: 1.2,
			}),
			text("contact", { x: 122, y: 6, w: 240, h: 34 }, "{{contact}}", { bold: true }),
			text("detail", { x: 122, y: 46, w: 240, h: 22 }, "{{detail}}"),
		]),
		fields: [
			field("contact", "Email or phone", "owner@example.com"),
			field("detail", "Detail", "Reward offered · thank you"),
		],
	}),
	personal({
		slug: "luggage-tag",
		name: "Luggage tag",
		description: "Name, phone and email in three clear lines on 24 mm tape, for bags and cases.",
		doc: doc(
			[
				rect("block", { x: 0, y: 0, w: 112, h: 128 }),
				icon("icon", { x: 24, y: 32, w: 64, h: 64 }, "luggage", { invert: true }),
				text("name", { x: 128, y: 8, w: 320, h: 48 }, "{{name}}", { bold: true }),
				text("phone", { x: 128, y: 62, w: 320, h: 26 }, "{{phone}}"),
				text("email", { x: 128, y: 94, w: 320, h: 26 }, "{{email}}"),
			],
			{ tapeMm: 24 },
		),
		fields: [
			field("name", "Name", "Alex Example"),
			field("phone", "Phone", "+1 555 0100"),
			field("email", "Email", "alex@example.com"),
		],
	}),
	personal({
		slug: "gift",
		name: "Gift label",
		description: "For and from in italic serif inside a rounded border, for presents and jars.",
		doc: doc(
			[
				icon("icon", { x: 14, y: 17, w: 36, h: 36 }, "gift"),
				text("to", { x: 60, y: 8, w: 200, h: 34 }, "For {{to}}", {
					font: "source-serif",
					italic: true,
					bold: true,
				}),
				text("from", { x: 60, y: 44, w: 200, h: 18 }, "from {{from}}", {
					font: "source-serif",
					italic: true,
				}),
			],
			{ border: { stroke: 1, radius: 14, inset: 3 }, margin: { startMm: 1.5, endMm: 2.5 } },
		),
		fields: [field("to", "For", "Robin"), field("from", "From", "Sam")],
	}),
];
