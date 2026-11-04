import { category, code, doc, field, icon, rect, START, text } from "./build.ts";

const office = category("office");

export const OFFICE = [
	office({
		slug: "file-folder",
		name: "File folder",
		description:
			"A folder tab with the year in a block and a condensed title that fits a narrow tab.",
		doc: doc([
			rect("block", { x: 0, y: 0, w: 86, h: 70 }),
			text("year", { x: 6, y: 14, w: 74, h: 42 }, "{{year}}", {
				font: "barlow-condensed",
				bold: true,
				align: "center",
				invert: true,
				widthMode: "fixed",
			}),
			text("title", { x: 96, y: 8, w: 200, h: 54 }, "{{title}}", { font: "barlow-condensed" }),
		]),
		fields: [field("year", "Year", "2026"), field("title", "Title", "Insurance")],
	}),
	office({
		slug: "binder-spine",
		name: "Binder spine",
		description:
			"Runs down a binder spine with the title, subject and year stacked upright. Laid out for 24 mm tape.",
		doc: doc(
			[
				text("title", { x: 8, y: 24, w: 112, h: 48 }, "{{title}}", {
					font: "source-serif",
					bold: true,
					align: "center",
					widthMode: "fixed",
				}),
				text("subject", { x: 8, y: 78, w: 112, h: 22 }, "{{subject}}", {
					font: "source-serif",
					italic: true,
					align: "center",
					widthMode: "fixed",
				}),
				rect("rule", { x: 44, y: 382, w: 40, h: 2 }),
				text("year", { x: 8, y: 400, w: 112, h: 40 }, "{{year}}", {
					font: "source-serif",
					align: "center",
					widthMode: "fixed",
				}),
			],
			{
				tapeMm: 24,
				orientation: "vertical",
				length: { mode: "fixed", mm: 66 },
				margin: { startMm: 0, endMm: 0 },
			},
		),
		fields: [
			field("title", "Title", "Taxes"),
			field("subject", "Subject", "Returns and receipts"),
			field("year", "Year", "2026"),
		],
	}),
	office({
		slug: "return-address",
		name: "Return address",
		description: "Three lines for the back of an envelope or a package.",
		doc: doc([
			icon("icon", { x: START, y: 17, w: 36, h: 36 }, "mail"),
			text("address", { x: 56, y: 3, w: 260, h: 64 }, "{{address}}", { lineHeight: 1.15 }),
		]),
		fields: [
			field("address", "Address", "Alex Example\n123 Sample Street\nSpringfield, ST 00000", {
				kind: "multiline",
			}),
		],
	}),
	office({
		slug: "name-badge",
		name: "Name badge",
		description: "Hello, my name is: a bold name and a role on 24 mm tape, for events and desks.",
		doc: doc(
			[
				rect("block", { x: 0, y: 0, w: 120, h: 128 }),
				text("hello", { x: 10, y: 28, w: 100, h: 40 }, "HELLO", {
					bold: true,
					align: "center",
					invert: true,
					widthMode: "fixed",
				}),
				text("my-name", { x: 10, y: 72, w: 100, h: 24 }, "my name is", {
					align: "center",
					invert: true,
					widthMode: "fixed",
				}),
				text("name", { x: 136, y: 12, w: 300, h: 72 }, "{{name}}", { bold: true }),
				text("role", { x: 136, y: 90, w: 300, h: 26 }, "{{role}}"),
			],
			{ tapeMm: 24 },
		),
		fields: [field("name", "Name", "Sam"), field("role", "Role", "Volunteer")],
	}),
	office({
		slug: "price-tag",
		name: "Price tag",
		description:
			"A big price and item name beside an EAN-13 barcode. The check digit is added if you leave it off.",
		doc: doc([
			text("price", { x: START, y: 4, w: 112, h: 40 }, "{{price}}", {
				bold: true,
				widthMode: "fixed",
			}),
			text("item", { x: START, y: 48, w: 112, h: 18 }, "{{item}}", { widthMode: "fixed" }),
			code("barcode", { x: 130, y: 2, w: 240, h: 66 }, "ean13", "{{ean}}"),
		]),
		fields: [
			field("price", "Price", "$4.99"),
			field("item", "Item", "Notebook A5"),
			field("ean", "EAN-13", "590123412345", { kind: "number" }),
		],
	}),
	office({
		slug: "product-barcode",
		name: "Product barcode",
		description: "Product name and variant beside a Code 128 SKU that any scanner reads.",
		doc: doc([
			text("name", { x: START, y: 6, w: 150, h: 34 }, "{{name}}", {
				bold: true,
				widthMode: "fixed",
			}),
			text("variant", { x: START, y: 46, w: 150, h: 18 }, "{{variant}}", { widthMode: "fixed" }),
			code("sku", { x: 168, y: 2, w: 240, h: 66 }, "code128", "{{sku}}"),
		]),
		fields: [
			field("name", "Product", "Tote bag"),
			field("variant", "Variant", "Natural · large"),
			field("sku", "SKU", "TB-NAT-L"),
		],
	}),
];
