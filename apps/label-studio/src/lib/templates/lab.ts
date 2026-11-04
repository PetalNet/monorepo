import { category, code, doc, field, icon, qr, rect, START, text } from "./build.ts";

const lab = category("lab");

/** A flag folds back to back around the cable: two equal ends with a short wrap between them. */
const FLAG_END = 141;
const FLAG_WRAP = 142;

/** Short ticks where the flag folds, so it is easy to wrap evenly. */
const foldTicks = [FLAG_END, FLAG_END + FLAG_WRAP].flatMap((x, i) => [
	rect(`fold-${String(i)}-top`, { x, y: 0, w: 1, h: 6 }),
	rect(`fold-${String(i)}-bottom`, { x, y: 64, w: 1, h: 6 }),
]);

const flagEnds = (make: (id: string, x: number) => ReturnType<typeof text>[]) => [
	...make("a", 6),
	...make("b", FLAG_END + FLAG_WRAP + 6),
];

const PANEL_CELL = 128;
const PANEL_PORTS = 6;

export const LAB = [
	lab({
		slug: "cable-flag",
		name: "Cable flag",
		description: "Folds around a cable into a flag that reads the same from both sides.",
		doc: doc(
			[
				...flagEnds((id, x) => [
					text(id, { x, y: 4, w: FLAG_END - 12, h: 62 }, "{{label}}", {
						font: "barlow-condensed",
						bold: true,
						align: "center",
						widthMode: "fixed",
					}),
				]),
				...foldTicks,
			],
			{ length: { mode: "fixed", mm: 60 }, margin: { startMm: 0, endMm: 0 } },
		),
		fields: [field("label", "Label", "NAS eth0")],
	}),
	lab({
		slug: "asset-tag",
		name: "Asset tag",
		description: "Asset number and name beside a QR code that opens its inventory record.",
		doc: doc([
			qr("qr", { x: 4, y: 0, w: 70, h: 70 }, "{{url}}", { ecc: "L" }),
			text("asset", { x: 80, y: 6, w: 160, h: 34 }, "{{asset}}", {
				font: "jetbrains-mono",
				bold: true,
			}),
			text("name", { x: 80, y: 44, w: 160, h: 20 }, "{{name}}"),
		]),
		fields: [
			field("asset", "Asset number", "A-0042"),
			field("name", "Name", "Rack server"),
			field("url", "Link", "https://example.com/a/42", { kind: "url" }),
		],
	}),
	lab({
		slug: "patch-cable",
		name: "Patch cable",
		description:
			"A cable flag that says where the cable runs from and to. Print one per end, swapping the two.",
		doc: doc(
			[
				...flagEnds((id, x) => [
					text(`${id}-from`, { x, y: 4, w: FLAG_END - 12, h: 34 }, "{{from}}", {
						font: "barlow-condensed",
						bold: true,
						align: "center",
						widthMode: "fixed",
					}),
					text(`${id}-to`, { x, y: 44, w: FLAG_END - 12, h: 22 }, "to {{to}}", {
						font: "barlow-condensed",
						align: "center",
						widthMode: "fixed",
					}),
				]),
				...foldTicks,
			],
			{ length: { mode: "fixed", mm: 60 }, margin: { startMm: 0, endMm: 0 } },
		),
		fields: [field("from", "This end", "Switch 1/24"), field("to", "Other end", "Patch 1/12")],
	}),
	lab({
		slug: "cable-wrap",
		name: "Cable wrap",
		description:
			"Wraps around a thin cable with the name repeated, so it reads along the cable from any side. Best for short names.",
		doc: doc(
			[0, 1, 2, 3].map((i) =>
				text(`name-${String(i)}`, { x: 4, y: 8 + i * 68, w: 62, h: 28 }, "{{label}}", {
					font: "barlow-condensed",
					bold: true,
					align: "center",
					widthMode: "fixed",
				}),
			),
			{
				orientation: "vertical",
				length: { mode: "fixed", mm: 40 },
				margin: { startMm: 0, endMm: 0 },
			},
		),
		fields: [field("label", "Label", "HDMI 2")],
	}),
	lab({
		slug: "rack-unit",
		name: "Rack unit",
		description: "The rack position in a solid block, then the host it holds.",
		doc: doc([
			rect("block", { x: 0, y: 0, w: 96, h: 70 }),
			text("unit", { x: 8, y: 10, w: 80, h: 50 }, "{{unit}}", {
				font: "barlow-condensed",
				bold: true,
				align: "center",
				invert: true,
				widthMode: "fixed",
			}),
			text("host", { x: 106, y: 6, w: 200, h: 36 }, "{{host}}", { bold: true }),
			text("role", { x: 106, y: 46, w: 200, h: 20 }, "{{role}}"),
		]),
		fields: [
			field("unit", "Unit", "U12"),
			field("host", "Host", "web-01"),
			field("role", "Role", "1U · Web server"),
		],
	}),
	lab({
		slug: "network-port",
		name: "Network port",
		description: "A large port number with its VLAN, for switches and wall plates.",
		doc: doc([
			icon("icon", { x: START, y: 11, w: 48, h: 48 }, "ethernet-port"),
			text("port", { x: 68, y: 4, w: 120, h: 40 }, "{{port}}", { bold: true }),
			text("vlan", { x: 68, y: 48, w: 120, h: 18 }, "VLAN {{vlan}}"),
		]),
		fields: [field("port", "Port", "1/12"), field("vlan", "VLAN", "10", { kind: "number" })],
	}),
	lab({
		slug: "patch-panel",
		name: "Patch panel strip",
		description: `${String(PANEL_PORTS)} numbered cells 18 mm apart, one per port. Drag the cells to match your panel's spacing.`,
		doc: doc(
			[
				...Array.from({ length: PANEL_PORTS }, (_, i) =>
					text(
						`port-${String(i + 1)}`,
						{ x: i * PANEL_CELL + 4, y: 8, w: PANEL_CELL - 8, h: 54 },
						`{{p${String(i + 1)}}}`,
						{
							font: "barlow-condensed",
							bold: true,
							align: "center",
							widthMode: "fixed",
						},
					),
				),
				...Array.from({ length: PANEL_PORTS - 1 }, (_, i) =>
					rect(`divider-${String(i + 1)}`, { x: (i + 1) * PANEL_CELL, y: 10, w: 2, h: 50 }),
				),
			],
			{ length: { mode: "fixed", mm: 108 }, margin: { startMm: 0, endMm: 0 } },
		),
		fields: Array.from({ length: PANEL_PORTS }, (_, i) =>
			field(`p${String(i + 1)}`, `Port ${String(i + 1)}`, String(i + 1)),
		),
	}),
	lab({
		slug: "power-supply",
		name: "Power supply",
		description:
			"Which device a PSU or power brick feeds, with its voltage in a pill you can't miss.",
		doc: doc([
			icon("icon", { x: START, y: 13, w: 44, h: 44 }, "plug"),
			rect("pill", { x: 62, y: 10, w: 100, h: 50 }, { radius: 25 }),
			text("voltage", { x: 74, y: 20, w: 76, h: 30 }, "{{voltage}}", {
				bold: true,
				align: "center",
				invert: true,
				widthMode: "fixed",
			}),
			text("device", { x: 172, y: 6, w: 200, h: 36 }, "{{device}}", { bold: true }),
			text("detail", { x: 172, y: 46, w: 200, h: 18 }, "{{detail}}"),
		]),
		fields: [
			field("voltage", "Voltage", "12 V"),
			field("device", "Device", "NAS"),
			field("detail", "Detail", "PSU 1 of 2"),
		],
	}),
	lab({
		slug: "drive-tag",
		name: "Drive tag",
		description:
			"Disk name and size beside a Code 128 serial. Fields match the TrueNAS source, so a batch print needs no mapping.",
		doc: doc([
			text("name", { x: START, y: 4, w: 76, h: 36 }, "{{name}}", {
				bold: true,
				widthMode: "fixed",
			}),
			text("size", { x: START, y: 46, w: 76, h: 18 }, "{{size}}", { widthMode: "fixed" }),
			code("serial", { x: 96, y: 4, w: 300, h: 44 }, "code128", "{{serial}}"),
			text("model", { x: 96, y: 52, w: 300, h: 14 }, "{{model}}", { font: "jetbrains-mono" }),
		]),
		fields: [
			field("name", "Disk", "sda"),
			field("serial", "Serial", "ZX12AB34"),
			field("model", "Model", "Example NAS 4TB"),
			field("size", "Size", "4 TB"),
		],
	}),
	lab({
		slug: "proxmox-guest",
		name: "Proxmox guest",
		description:
			"VM or container ID in a block, then its name and type. Fields match the Proxmox source.",
		doc: doc([
			rect("block", { x: 0, y: 0, w: 92, h: 70 }),
			text("vmid", { x: 6, y: 10, w: 80, h: 50 }, "{{vmid}}", {
				font: "jetbrains-mono",
				bold: true,
				align: "center",
				invert: true,
				widthMode: "fixed",
			}),
			text("name", { x: 102, y: 6, w: 200, h: 36 }, "{{name}}", { bold: true }),
			text("type", { x: 102, y: 46, w: 200, h: 18 }, "{{type}}"),
		]),
		fields: [
			field("vmid", "ID", "101"),
			field("name", "Name", "media-server"),
			field("type", "Type", "VM"),
		],
	}),
	lab({
		slug: "hass-entity",
		name: "Home Assistant device",
		description:
			"A device's friendly name over its entity ID. Fields match the Home Assistant source.",
		doc: doc([
			icon("icon", { x: START, y: 13, w: 44, h: 44 }, "house-wifi"),
			text("name", { x: 64, y: 6, w: 200, h: 36 }, "{{name}}", { bold: true }),
			text("entity", { x: 64, y: 46, w: 200, h: 18 }, "{{entity_id}}", { font: "jetbrains-mono" }),
		]),
		fields: [
			field("name", "Name", "Hallway sensor"),
			field("entity_id", "Entity ID", "sensor.hallway_temperature"),
		],
	}),
];
