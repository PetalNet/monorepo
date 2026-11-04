import type { Bitmap, Border, ShapeElement } from "$lib/doc";

import { dash, fill, fillRect, PathBuilder, reversed, stroke } from "./raster.ts";

/** Dash and gap lengths in dots for a dashed outline of width `t`. */
const dashPattern = (t: number): [number, number] => [Math.max(2, 3 * t), Math.max(2, 2 * t)];

/**
 * A rounded-rect or ellipse outline `t` dots wide, kept inside the `w × h` box: a ring when solid,
 * round-capped dashes along the centreline when dashed.
 */
function outline(
	target: Bitmap,
	shape: "rect" | "ellipse",
	w: number,
	h: number,
	t: number,
	radius: number,
	dashed: boolean,
	scale: number,
	margin = 0,
): void {
	const path = (depth: number): PathBuilder => {
		const builder = new PathBuilder().transform(scale, scale, 0, 0);
		const inset = margin + depth;

		return shape === "rect"
			? builder.roundRect(inset, inset, w - 2 * inset, h - 2 * inset, Math.max(0, radius - depth))
			: builder.ellipse(w / 2, h / 2, w / 2 - inset, h / 2 - inset);
	};

	if (dashed) {
		const [on, off] = dashPattern(t);

		stroke(target, dash(path(t / 2).lines, on * scale, off * scale), (t / 2) * scale);

		return;
	}

	const inner = 2 * (margin + t) < Math.min(w, h) ? reversed(path(t).lines) : [];

	fill(target, [...path(0).lines, ...inner]);
}

export function drawShape(
	target: Bitmap,
	el: ShapeElement,
	w: number,
	h: number,
	scale: number,
): void {
	const t = Math.max(0, el.stroke);

	switch (el.shape) {
		case "rect":
		case "ellipse": {
			if (el.fill) {
				const path = new PathBuilder().transform(scale, scale, 0, 0);

				fill(
					target,
					(el.shape === "rect"
						? path.roundRect(0, 0, w, h, el.radius)
						: path.ellipse(w / 2, h / 2, w / 2, h / 2)
					).lines,
				);
			} else if (t > 0) {
				outline(target, el.shape, w, h, t, el.radius, el.dashed, scale);
			}

			break;
		}
		case "line-h":
		case "line-v": {
			const horizontal = el.shape === "line-h";
			const length = horizontal ? w : h;
			const thickness = Math.max(1, t);
			const offset = Math.floor(((horizontal ? h : w) - thickness) / 2);
			const [on, off] = el.dashed ? dashPattern(thickness) : [length, 0];

			for (let start = 0; start < length; start += on + off) {
				const run = Math.min(on, length - start);

				if (horizontal) {
					fillRect(target, start * scale, offset * scale, run * scale, thickness * scale);
				} else {
					fillRect(target, offset * scale, start * scale, thickness * scale, run * scale);
				}
			}

			break;
		}
	}
}

/** The label border: a solid rounded ring `inset` dots in from the frame edge. */
export function drawBorder(
	target: Bitmap,
	border: Border,
	w: number,
	h: number,
	scale: number,
): void {
	const inset = Math.max(0, border.inset);

	if (border.stroke > 0 && 2 * inset < Math.min(w, h)) {
		outline(target, "rect", w, h, border.stroke, border.radius, false, scale, inset);
	}
}
