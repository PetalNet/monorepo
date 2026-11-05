import { category, doc, field, icon, qr, START, text } from "./build.ts";

const qrCategory = category("qr");

export const QR = [
	qrCategory({
		slug: "wifi-qr",
		name: "Wi-Fi QR",
		description:
			"Scan to join a WPA network. Laid out for 24 mm tape so phones read the code from arm's length.",
		doc: doc(
			[
				qr("qr", { x: 4, y: 0, w: 128, h: 128 }, "WIFI:T:WPA;S:{{ssid}};P:{{password}};;", {
					ecc: "L",
					escapeFields: true,
				}),
				icon("icon", { x: 144, y: 22, w: 28, h: 28 }, "wifi"),
				text("lead", { x: 180, y: 24, w: 200, h: 24 }, "Scan to join"),
				text("ssid", { x: 144, y: 60, w: 300, h: 44 }, "{{ssid}}", { bold: true }),
			],
			{ tapeMm: 24 },
		),
		fields: [
			field("ssid", "Network name", "Guest network"),
			field("password", "Password", "correct-horse-42"),
		],
	}),
	qrCategory({
		slug: "wifi-card",
		name: "Wi-Fi password",
		description:
			"Network name and password in a monospaced face that keeps 0 and O, 1 and l apart.",
		doc: doc([
			icon("icon", { x: START, y: 13, w: 44, h: 44 }, "wifi"),
			text("ssid", { x: 64, y: 2, w: 240, h: 40 }, "{{ssid}}", { bold: true }),
			text("password", { x: 64, y: 44, w: 240, h: 24 }, "{{password}}", { font: "jetbrains-mono" }),
		]),
		fields: [
			field("ssid", "Network name", "Guest network"),
			field("password", "Password", "correct-horse-42"),
		],
	}),
	qrCategory({
		slug: "contact-qr",
		name: "Contact card",
		description:
			"A MECARD QR that saves your name, phone and email to a phone's contacts, on 24 mm tape.",
		doc: doc(
			[
				qr(
					"qr",
					{ x: 4, y: 0, w: 128, h: 128 },
					"MECARD:N:{{name}};TEL:{{phone}};EMAIL:{{email}};;",
					{
						ecc: "L",
						escapeFields: true,
					},
				),
				text("name", { x: 144, y: 10, w: 300, h: 44 }, "{{name}}", { bold: true }),
				text("phone", { x: 144, y: 62, w: 300, h: 24 }, "{{phone}}"),
				text("email", { x: 144, y: 94, w: 300, h: 24 }, "{{email}}"),
			],
			{ tapeMm: 24 },
		),
		fields: [
			field("name", "Name", "Alex Example"),
			field("phone", "Phone", "+1 555 0100"),
			field("email", "Email", "alex@example.com"),
		],
	}),
	qrCategory({
		slug: "link-qr",
		name: "Link QR",
		description:
			"A QR code that opens a web page, with a title and the address spelled out. Short links scan best.",
		doc: doc([
			qr("qr", { x: 4, y: 0, w: 70, h: 70 }, "{{url}}", { ecc: "L" }),
			text("title", { x: 82, y: 2, w: 240, h: 44 }, "{{title}}", { bold: true }),
			text("url", { x: 82, y: 46, w: 240, h: 22 }, "{{url}}", { font: "jetbrains-mono" }),
		]),
		fields: [
			field("title", "Title", "Manual"),
			field("url", "Link", "https://example.com", { kind: "url" }),
		],
	}),
];
