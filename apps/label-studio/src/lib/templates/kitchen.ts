import { category, dateField, doc, field, icon, rect, START, text } from "./build.ts";

const kitchen = category("kitchen");

export const KITCHEN = [
	kitchen({
		slug: "food-date",
		name: "Food and date",
		description: "What it is and the day it was made, for jars and lunch boxes.",
		doc: doc([
			text("item", { x: START, y: 4, w: 200, h: 40 }, "{{item}}", { font: "nunito", bold: true }),
			text("date", { x: START, y: 48, w: 200, h: 18 }, "Made {{date}}", { font: "nunito" }),
		]),
		fields: [field("item", "Item", "Tomato soup"), dateField("date", "Made")],
	}),
	kitchen({
		slug: "use-within",
		name: "Use within",
		description:
			"How long it keeps after opening in a block up front, then the item and the day it was opened.",
		doc: doc([
			rect("block", { x: 0, y: 0, w: 104, h: 70 }),
			text("heading", { x: 6, y: 6, w: 92, h: 16 }, "USE WITHIN", {
				font: "nunito",
				bold: true,
				align: "center",
				invert: true,
				widthMode: "fixed",
				tracking: 1,
			}),
			text("within", { x: 6, y: 26, w: 92, h: 38 }, "{{within}}", {
				font: "nunito",
				bold: true,
				align: "center",
				invert: true,
				widthMode: "fixed",
			}),
			text("item", { x: 114, y: 4, w: 200, h: 40 }, "{{item}}", { font: "nunito", bold: true }),
			text("opened", { x: 114, y: 48, w: 200, h: 18 }, "Opened {{opened}}", { font: "nunito" }),
		]),
		fields: [
			field("within", "Use within", "5 days"),
			field("item", "Item", "Pesto"),
			dateField("opened", "Opened"),
		],
	}),
	kitchen({
		slug: "freezer",
		name: "Freezer",
		description:
			"Leftovers with the day they went in and how many portions, so the oldest gets eaten first.",
		doc: doc([
			icon("icon", { x: START, y: 13, w: 44, h: 44 }, "snowflake"),
			text("item", { x: 64, y: 4, w: 200, h: 40 }, "{{item}}", { font: "nunito", bold: true }),
			text("frozen", { x: 64, y: 48, w: 240, h: 18 }, "Frozen {{date}} · {{portions}}", {
				font: "nunito",
			}),
		]),
		fields: [
			field("item", "Item", "Chili"),
			dateField("date", "Frozen"),
			field("portions", "Portions", "2 portions"),
		],
	}),
	kitchen({
		slug: "spice-jar",
		name: "Spice jar",
		description: "One big centred serif name on a short fixed length that fits a jar lid or front.",
		doc: doc(
			[
				text("name", { x: 8, y: 6, w: 197, h: 58 }, "{{name}}", {
					font: "source-serif",
					bold: true,
					align: "center",
					widthMode: "fixed",
				}),
			],
			{ length: { mode: "fixed", mm: 30 }, margin: { startMm: 0, endMm: 0 } },
		),
		fields: [field("name", "Spice", "Paprika")],
	}),
];
