import { category, doc, field, icon, START, text } from "./build.ts";

const school = category("school");

export const SCHOOL = [
	school({
		slug: "school-supplies",
		name: "School supplies",
		description: "A friendly rounded name and class for pencil cases, lunch boxes and bottles.",
		doc: doc(
			[
				icon("icon", { x: 14, y: 15, w: 40, h: 40 }, "pencil"),
				text("name", { x: 62, y: 8, w: 200, h: 34 }, "{{name}}", { font: "nunito", bold: true }),
				text("class", { x: 62, y: 46, w: 200, h: 16 }, "{{class}}", { font: "nunito" }),
			],
			{ border: { stroke: 2, radius: 12, inset: 2 }, margin: { startMm: 1.5, endMm: 2.5 } },
		),
		fields: [field("name", "Name", "Sam"), field("class", "Class", "Class 3B")],
	}),
	school({
		slug: "book-owner",
		name: "This book belongs to",
		description: "A bookplate line in italic serif over the owner's name.",
		doc: doc([
			icon("icon", { x: START, y: 15, w: 40, h: 40 }, "book-open"),
			text("lead", { x: 60, y: 6, w: 200, h: 20 }, "This book belongs to", {
				font: "source-serif",
				italic: true,
			}),
			text("name", { x: 60, y: 30, w: 200, h: 36 }, "{{name}}", {
				font: "source-serif",
				bold: true,
			}),
		]),
		fields: [field("name", "Name", "Sam Example")],
	}),
];
