import { category, dateField, doc, field, icon, rect, text } from "./build.ts";

const garden = category("garden");

export const GARDEN = [
	garden({
		slug: "plant-marker",
		name: "Plant marker",
		description:
			"Common name, the Latin name in italic, and the sowing date, for pots and plant stakes.",
		doc: doc([
			rect("block", { x: 0, y: 0, w: 96, h: 70 }),
			icon("icon", { x: 34, y: 5, w: 28, h: 28 }, "sprout", { invert: true }),
			text("sown", { x: 4, y: 38, w: 88, h: 24 }, "{{sown}}", {
				font: "barlow-condensed",
				bold: true,
				align: "center",
				invert: true,
				widthMode: "fixed",
			}),
			text("name", { x: 106, y: 4, w: 200, h: 38 }, "{{name}}", {
				font: "source-serif",
				bold: true,
			}),
			text("latin", { x: 106, y: 46, w: 200, h: 22 }, "{{latin}}", {
				font: "source-serif",
				italic: true,
			}),
		]),
		fields: [
			field("name", "Name", "Tomato"),
			field("latin", "Latin name", "Solanum lycopersicum"),
			dateField("sown", "Sown"),
		],
	}),
	garden({
		slug: "seed-tray",
		name: "Seed tray",
		description:
			"A short fixed-length tag for a seed tray or cell: the variety and the day it was sown.",
		doc: doc(
			[
				rect("block", { x: 0, y: 46, w: 213, h: 24 }),
				text("variety", { x: 8, y: 4, w: 197, h: 38 }, "{{variety}}", {
					font: "barlow-condensed",
					bold: true,
					align: "center",
					widthMode: "fixed",
				}),
				text("sown", { x: 8, y: 49, w: 197, h: 18 }, "Sown {{sown}}", {
					font: "barlow-condensed",
					align: "center",
					invert: true,
					widthMode: "fixed",
				}),
			],
			{ length: { mode: "fixed", mm: 30 }, margin: { startMm: 0, endMm: 0 } },
		),
		fields: [field("variety", "Variety", "Basil Genovese"), dateField("sown", "Sown")],
	}),
];
