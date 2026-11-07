import type { Bitmap } from "$lib/doc";
import svgpath from "svgpath";

import { fill, PathBuilder, stroke } from "./raster.ts";

type Attrs = Readonly<Record<string, string | number | undefined>>;
/** Lucide's icon data: SVG child elements on a 24-unit grid, stroked with currentColor. */
export type IconNode = readonly (readonly [tag: string, attrs: Attrs])[];
export type IconSet = (name: string) => IconNode | null;

const pascal = (kebab: string): string =>
	kebab
		.split("-")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("");

const isIconNode = (value: unknown): value is IconNode =>
	Array.isArray(value) &&
	value.every(
		(child: unknown) =>
			Array.isArray(child) && typeof child[0] === "string" && typeof child[1] === "object",
	);

/**
 * Lucide as a lazily imported module, so the icon data ships as its own chunk that only loads once
 * a label has an icon. Kebab names map to Lucide's PascalCase exports, which include its aliases.
 */
export async function loadIcons(): Promise<IconSet> {
	const module: Readonly<Record<string, unknown>> = await import("lucide");

	return (name) => {
		const node = module[pascal(name)];

		return /^[a-z0-9-]+$/.test(name) && isIconNode(node) ? node : null;
	};
}

const num = (attrs: Attrs, key: string): number => Number(attrs[key] ?? 0);

function points(path: PathBuilder, list: string, close: boolean): void {
	const values = list
		.trim()
		.split(/[\s,]+/)
		.map(Number);

	for (let i = 0; i + 1 < values.length; i += 2) {
		if (i === 0) {
			path.moveTo(values[0], values[1]);
		} else {
			path.lineTo(values[i], values[i + 1]);
		}
	}

	if (close) {
		path.close();
	}
}

function svgPath(path: PathBuilder, d: string): void {
	svgpath(d)
		.abs()
		.unarc()
		.unshort()
		.iterate((segment, _index, x, y) => {
			if (segment[0] === "M") {
				path.moveTo(segment[1], segment[2]);
			} else if (segment[0] === "L") {
				path.lineTo(segment[1], segment[2]);
			} else if (segment[0] === "H") {
				path.lineTo(segment[1], y);
			} else if (segment[0] === "V") {
				path.lineTo(x, segment[1]);
			} else if (segment[0] === "Q") {
				path.quadTo(segment[1], segment[2], segment[3], segment[4]);
			} else if (segment[0] === "C") {
				path.cubicTo(segment[1], segment[2], segment[3], segment[4], segment[5], segment[6]);
			} else if (segment[0] === "Z" || segment[0] === "z") {
				path.close();
			}
		});
}

function shape(path: PathBuilder, tag: string, attrs: Attrs): void {
	switch (tag) {
		case "path":
			svgPath(path, String(attrs.d ?? ""));

			break;
		case "circle":
			path.ellipse(num(attrs, "cx"), num(attrs, "cy"), num(attrs, "r"), num(attrs, "r"));

			break;
		case "ellipse":
			path.ellipse(num(attrs, "cx"), num(attrs, "cy"), num(attrs, "rx"), num(attrs, "ry"));

			break;
		case "rect":
			path.roundRect(
				num(attrs, "x"),
				num(attrs, "y"),
				num(attrs, "width"),
				num(attrs, "height"),
				num(attrs, "rx") || num(attrs, "ry"),
			);

			break;
		case "line":
			path.moveTo(num(attrs, "x1"), num(attrs, "y1")).lineTo(num(attrs, "x2"), num(attrs, "y2"));

			break;
		case "polyline":
		case "polygon":
			points(path, String(attrs.points ?? ""), tag === "polygon");

			break;
		default:
			break;
	}
}

/**
 * Draw an icon centred in the `w × h` dot box, its 24-unit grid scaled to the shorter side, stroked
 * `strokeWidth` grid units wide with round caps and joins.
 */
export function drawIcon(
	target: Bitmap,
	icon: IconNode,
	w: number,
	h: number,
	strokeWidth: number,
	scale: number,
): void {
	const unit = (Math.min(w, h) / 24) * scale;
	const tx = (w * scale - 24 * unit) / 2;
	const ty = (h * scale - 24 * unit) / 2;
	const radius = (Math.max(0, strokeWidth) * unit) / 2;

	for (const [tag, attrs] of icon) {
		const path = new PathBuilder().transform(unit, unit, tx, ty);

		shape(path, tag, attrs);

		if (attrs.fill !== undefined && attrs.fill !== "none") {
			fill(target, path.lines);
		}

		if (radius > 0) {
			stroke(target, path.lines, radius);
		}
	}
}
