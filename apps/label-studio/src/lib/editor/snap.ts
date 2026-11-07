import type { Box } from "$lib/doc";

/** A guide line the editor draws while snapping, in frame dots. */
export interface Guide {
	axis: "x" | "y";
	at: number;
}

export interface SnapTargets {
	x: number[];
	y: number[];
}

/** Snap lines: band edges and centre, the start/end margins, and other elements' edges and centres. */
export function snapTargets(
	frame: { w: number; h: number },
	margins: { start: number; end: number | null },
	others: readonly Box[],
	along: "x" | "y",
): SnapTargets {
	const targets: SnapTargets = {
		x: [0, frame.w, frame.w / 2],
		y: [0, frame.h, frame.h / 2],
	};

	targets[along].push(margins.start);

	if (margins.end !== null) {
		targets[along].push(margins.end);
	}

	for (const box of others) {
		targets.x.push(box.x, box.x + box.w / 2, box.x + box.w);
		targets.y.push(box.y, box.y + box.h / 2, box.y + box.h);
	}

	return targets;
}

function nearest(
	edges: readonly number[],
	lines: readonly number[],
	threshold: number,
): { delta: number; at: number } | null {
	let best: { delta: number; at: number } | null = null;

	for (const edge of edges) {
		for (const line of lines) {
			const delta = line - edge;

			if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) {
				best = { delta, at: line };
			}
		}
	}

	return best;
}

/**
 * Snap a moving box: whichever of its left/centre/right (and top/middle/bottom) lands within
 * `threshold` dots of a target line is pulled onto it.
 */
export function snapBox(
	box: Box,
	targets: SnapTargets,
	threshold: number,
): { box: Box; guides: Guide[] } {
	const x = nearest([box.x, box.x + box.w / 2, box.x + box.w], targets.x, threshold);
	const y = nearest([box.y, box.y + box.h / 2, box.y + box.h], targets.y, threshold);
	const guides: Guide[] = [];

	if (x) {
		guides.push({ axis: "x", at: x.at });
	}

	if (y) {
		guides.push({ axis: "y", at: y.at });
	}

	return {
		box: { ...box, x: Math.round(box.x + (x?.delta ?? 0)), y: Math.round(box.y + (y?.delta ?? 0)) },
		guides,
	};
}

/** Snap only the moving edges of a box being resized from `handle`. */
export function snapResize(
	box: Box,
	handle: Handle,
	targets: SnapTargets,
	threshold: number,
): { box: Box; guides: Guide[] } {
	const guides: Guide[] = [];
	let { x, y, w, h } = box;

	if (handle.includes("w")) {
		const hit = nearest([x], targets.x, threshold);

		if (hit) {
			w -= hit.delta;
			x += hit.delta;
			guides.push({ axis: "x", at: hit.at });
		}
	} else if (handle.includes("e")) {
		const hit = nearest([x + w], targets.x, threshold);

		if (hit) {
			w += hit.delta;
			guides.push({ axis: "x", at: hit.at });
		}
	}

	if (handle.includes("n")) {
		const hit = nearest([y], targets.y, threshold);

		if (hit) {
			h -= hit.delta;
			y += hit.delta;
			guides.push({ axis: "y", at: hit.at });
		}
	} else if (handle.includes("s")) {
		const hit = nearest([y + h], targets.y, threshold);

		if (hit) {
			h += hit.delta;
			guides.push({ axis: "y", at: hit.at });
		}
	}

	return {
		box: { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) },
		guides,
	};
}

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** Resize `start` by a pointer delta from `handle`. `keepRatio` holds the aspect (icons, 2D codes). */
export function resizeBox(
	start: Box,
	handle: Handle,
	dx: number,
	dy: number,
	keepRatio: boolean,
	min = 2,
): Box {
	let { x, y, w, h } = start;

	if (handle.includes("e")) {
		w = start.w + dx;
	}

	if (handle.includes("w")) {
		w = start.w - dx;
	}

	if (handle.includes("s")) {
		h = start.h + dy;
	}

	if (handle.includes("n")) {
		h = start.h - dy;
	}

	if (keepRatio && start.w > 0 && start.h > 0) {
		const ratio = start.w / start.h;
		const horizontalOnly = handle === "e" || handle === "w";
		const verticalOnly = handle === "n" || handle === "s";

		if (horizontalOnly || (!verticalOnly && Math.abs(dx) >= Math.abs(dy))) {
			h = w / ratio;
		} else {
			w = h * ratio;
		}
	}

	w = Math.max(min, w);
	h = Math.max(min, h);

	if (handle.includes("w")) {
		x = start.x + start.w - w;
	}

	if (handle.includes("n")) {
		y = start.y + start.h - h;
	}

	return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}
