import type { Bitmap } from "$lib/doc";

/** A flattened subpath in pixel space: `[x0, y0, x1, y1, ...]`. */
export interface Polyline {
	points: number[];
	closed: boolean;
}

/** Maximum distance in pixels between a curve and its flattened chords. */
const TOLERANCE = 0.1;
const KAPPA = 0.552_284_749_8;

export function bitmap(width: number, height: number): Bitmap {
	return { width, height, data: new Uint8Array(width * height) };
}

/** Collects move/line/quad/cubic commands into polylines, scaling then translating each point. */
export class PathBuilder {
	readonly lines: Polyline[] = [];
	private current: number[] | null = null;
	private x = 0;
	private y = 0;
	private sx = 1;
	private sy = 1;
	private tx = 0;
	private ty = 0;

	transform(sx: number, sy: number, tx: number, ty: number): this {
		this.sx = sx;
		this.sy = sy;
		this.tx = tx;
		this.ty = ty;

		return this;
	}

	moveTo(x: number, y: number): this {
		this.x = this.tx + x * this.sx;
		this.y = this.ty + y * this.sy;
		this.current = [this.x, this.y];
		this.lines.push({ points: this.current, closed: false });

		return this;
	}

	lineTo(x: number, y: number): this {
		this.push(this.tx + x * this.sx, this.ty + y * this.sy);

		return this;
	}

	quadTo(cx: number, cy: number, x: number, y: number): this {
		const x0 = this.x;
		const y0 = this.y;
		const x1 = this.tx + cx * this.sx;
		const y1 = this.ty + cy * this.sy;
		const x2 = this.tx + x * this.sx;
		const y2 = this.ty + y * this.sy;
		const n = Math.ceil(
			Math.sqrt(Math.hypot(x0 - 2 * x1 + x2, y0 - 2 * y1 + y2) / (4 * TOLERANCE)),
		);

		for (let i = 1; i <= n; i++) {
			const t = i / n;
			const u = 1 - t;

			this.push(u * u * x0 + 2 * u * t * x1 + t * t * x2, u * u * y0 + 2 * u * t * y1 + t * t * y2);
		}

		return this;
	}

	cubicTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): this {
		const x0 = this.x;
		const y0 = this.y;
		const x1 = this.tx + c1x * this.sx;
		const y1 = this.ty + c1y * this.sy;
		const x2 = this.tx + c2x * this.sx;
		const y2 = this.ty + c2y * this.sy;
		const x3 = this.tx + x * this.sx;
		const y3 = this.ty + y * this.sy;
		const bend = Math.max(
			Math.hypot(x0 - 2 * x1 + x2, y0 - 2 * y1 + y2),
			Math.hypot(x1 - 2 * x2 + x3, y1 - 2 * y2 + y3),
		);
		const n = Math.ceil(Math.sqrt((3 * bend) / (4 * TOLERANCE)));

		for (let i = 1; i <= n; i++) {
			const t = i / n;
			const u = 1 - t;
			const a = u * u * u;
			const b = 3 * u * u * t;
			const c = 3 * u * t * t;
			const d = t * t * t;

			this.push(a * x0 + b * x1 + c * x2 + d * x3, a * y0 + b * y1 + c * y2 + d * y3);
		}

		return this;
	}

	close(): this {
		if (this.current) {
			const last = this.lines.at(-1);

			if (last) {
				last.closed = true;
				this.x = this.current[0];
				this.y = this.current[1];
			}
		}

		this.current = null;

		return this;
	}

	/** A rectangle with corner radius `r`, clockwise in y-down space. */
	roundRect(x: number, y: number, w: number, h: number, r: number): this {
		const radius = Math.max(0, Math.min(r, w / 2, h / 2));

		if (radius === 0) {
			return this.moveTo(x, y)
				.lineTo(x + w, y)
				.lineTo(x + w, y + h)
				.lineTo(x, y + h)
				.close();
		}

		const k = radius * (1 - KAPPA);

		return this.moveTo(x + radius, y)
			.lineTo(x + w - radius, y)
			.cubicTo(x + w - k, y, x + w, y + k, x + w, y + radius)
			.lineTo(x + w, y + h - radius)
			.cubicTo(x + w, y + h - k, x + w - k, y + h, x + w - radius, y + h)
			.lineTo(x + radius, y + h)
			.cubicTo(x + k, y + h, x, y + h - k, x, y + h - radius)
			.lineTo(x, y + radius)
			.cubicTo(x, y + k, x + k, y, x + radius, y)
			.close();
	}

	ellipse(cx: number, cy: number, rx: number, ry: number): this {
		const kx = rx * KAPPA;
		const ky = ry * KAPPA;

		return this.moveTo(cx + rx, cy)
			.cubicTo(cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry)
			.cubicTo(cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy)
			.cubicTo(cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry)
			.cubicTo(cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy)
			.close();
	}

	private push(x: number, y: number): void {
		if (!this.current) {
			this.moveTo((this.x - this.tx) / this.sx, (this.y - this.ty) / this.sy);
		}

		this.current?.push(x, y);
		this.x = x;
		this.y = y;
	}
}

/**
 * Scan polylines as closed nonzero rings, one scanline per pixel row (or column when `swap`),
 * calling `span` for every inside run with its edge crossings at that line's pixel centres.
 */
function scan(
	lines: readonly Polyline[],
	extent: number,
	swap: boolean,
	span: (line: number, x0: number, x1: number) => void,
): void {
	const [xOffset, yOffset] = swap ? [1, 0] : [0, 1];
	let top = Infinity;
	let bottom = -Infinity;

	for (const { points } of lines) {
		for (let i = yOffset; i < points.length; i += 2) {
			top = Math.min(top, points[i]);
			bottom = Math.max(bottom, points[i]);
		}
	}

	const rowStart = Math.max(0, Math.ceil(top - 0.5));
	const rowEnd = Math.min(extent - 1, Math.ceil(bottom - 0.5) - 1);

	if (rowEnd < rowStart) {
		return;
	}

	const xs: number[][] = Array.from({ length: rowEnd - rowStart + 1 }, () => []);
	const dirs: number[][] = Array.from({ length: rowEnd - rowStart + 1 }, () => []);

	for (const { points } of lines) {
		const n = points.length / 2;

		for (let i = 0; i < n; i++) {
			const j = (i + 1) % n;
			const x0 = points[2 * i + xOffset];
			const y0 = points[2 * i + yOffset];
			const x1 = points[2 * j + xOffset];
			const y1 = points[2 * j + yOffset];

			if (y0 === y1) {
				continue;
			}

			const dir = y1 > y0 ? 1 : -1;
			const lo = Math.max(rowStart, Math.ceil(Math.min(y0, y1) - 0.5));
			const hi = Math.min(rowEnd, Math.ceil(Math.max(y0, y1) - 0.5) - 1);
			const slope = (x1 - x0) / (y1 - y0);

			for (let row = lo; row <= hi; row++) {
				const rowXs = xs[row - rowStart];
				const rowDirs = dirs[row - rowStart];
				const x = x0 + (row + 0.5 - y0) * slope;
				let k = rowXs.length;

				while (k > 0 && rowXs[k - 1] > x) {
					rowXs[k] = rowXs[k - 1];
					rowDirs[k] = rowDirs[k - 1];
					k--;
				}

				rowXs[k] = x;
				rowDirs[k] = dir;
			}
		}
	}

	for (let row = rowStart; row <= rowEnd; row++) {
		const rowXs = xs[row - rowStart];
		const rowDirs = dirs[row - rowStart];
		let winding = 0;

		for (let k = 0; k < rowXs.length - 1; k++) {
			winding += rowDirs[k];

			if (winding !== 0) {
				span(row, rowXs[k], rowXs[k + 1]);
			}
		}
	}
}

/**
 * Fill every polyline as a closed ring with the nonzero rule, sampling each pixel at its centre.
 * With `dropout`, a run thinner than a pixel that misses every centre still inks its nearest pixel,
 * scanning both rows and columns, so hairlines survive at small sizes without thickening anything
 * already wider than a dot (TrueType's dropout control).
 */
export function fill(target: Bitmap, lines: readonly Polyline[], dropout = false): void {
	const { width, height, data } = target;

	scan(lines, height, false, (row, x0, x1) => {
		const from = Math.max(0, Math.ceil(x0 - 0.5));
		const to = Math.min(width, Math.ceil(x1 - 0.5));

		if (to > from) {
			data.fill(255, row * width + from, row * width + to);
		} else if (dropout) {
			const col = Math.floor((x0 + x1) / 2);

			if (col >= 0 && col < width) {
				data[row * width + col] = 255;
			}
		}
	});

	if (dropout) {
		scan(lines, width, true, (col, y0, y1) => {
			if (Math.ceil(y1 - 0.5) <= Math.ceil(y0 - 0.5)) {
				const row = Math.floor((y0 + y1) / 2);

				if (row >= 0 && row < height) {
					data[row * width + col] = 255;
				}
			}
		});
	}
}

/** Fill the axis-aligned pixel rectangle `[x, x + w) × [y, y + h)`, clipped to the target. */
export function fillRect(target: Bitmap, x: number, y: number, w: number, h: number): void {
	const x0 = Math.max(0, Math.round(x));
	const x1 = Math.min(target.width, Math.round(x + w));
	const y0 = Math.max(0, Math.round(y));
	const y1 = Math.min(target.height, Math.round(y + h));

	if (x1 <= x0) {
		return;
	}

	for (let row = y0; row < y1; row++) {
		target.data.fill(255, row * target.width + x0, row * target.width + x1);
	}
}

/**
 * Stroke polylines with round caps and joins: ink every pixel whose centre lies within `radius` of
 * a segment. Each segment only visits its own expanded bounding box.
 */
export function stroke(target: Bitmap, lines: readonly Polyline[], radius: number): void {
	const { width, height, data } = target;
	const r2 = radius * radius;

	const segment = (ax: number, ay: number, bx: number, by: number): void => {
		const dx = bx - ax;
		const dy = by - ay;
		const len2 = dx * dx + dy * dy;
		const x0 = Math.max(0, Math.ceil(Math.min(ax, bx) - radius - 0.5));
		const x1 = Math.min(width - 1, Math.floor(Math.max(ax, bx) + radius - 0.5));
		const y0 = Math.max(0, Math.ceil(Math.min(ay, by) - radius - 0.5));
		const y1 = Math.min(height - 1, Math.floor(Math.max(ay, by) + radius - 0.5));

		for (let row = y0; row <= y1; row++) {
			const py = row + 0.5 - ay;

			for (let col = x0; col <= x1; col++) {
				const px = col + 0.5 - ax;
				const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
				const ex = px - t * dx;
				const ey = py - t * dy;

				if (ex * ex + ey * ey <= r2) {
					data[row * width + col] = 255;
				}
			}
		}
	};

	for (const { points, closed } of lines) {
		const n = points.length / 2;

		if (n === 1) {
			segment(points[0], points[1], points[0], points[1]);
		}

		for (let i = 0; i + 1 < n; i++) {
			segment(points[2 * i], points[2 * i + 1], points[2 * i + 2], points[2 * i + 3]);
		}

		if (closed && n > 2) {
			segment(points[2 * n - 2], points[2 * n - 1], points[0], points[1]);
		}
	}
}

/** Split polylines into dashes of `on` length separated by `off`, measured along the path. */
export function dash(lines: readonly Polyline[], on: number, off: number): Polyline[] {
	const out: Polyline[] = [];

	for (const { points, closed } of lines) {
		const pts = closed ? [...points, points[0], points[1]] : points;
		let drawing = true;
		let left = on;
		let current: number[] = [pts[0], pts[1]];

		for (let i = 2; i < pts.length; i += 2) {
			let ax = pts[i - 2];
			let ay = pts[i - 1];
			const bx = pts[i];
			const by = pts[i + 1];
			let len = Math.hypot(bx - ax, by - ay);

			while (len > left) {
				const t = left / len;

				ax += (bx - ax) * t;
				ay += (by - ay) * t;
				len -= left;

				if (drawing) {
					current.push(ax, ay);
					out.push({ points: current, closed: false });
				}

				current = [ax, ay];
				drawing = !drawing;
				left = drawing ? on : off;
			}

			left -= len;

			if (drawing) {
				current.push(bx, by);
			}
		}

		if (drawing && current.length > 2) {
			out.push({ points: current, closed: false });
		}
	}

	return out;
}

/** Reverse a polyline's direction, used to cut holes with the nonzero rule. */
export function reversed(lines: readonly Polyline[]): Polyline[] {
	return lines.map(({ points, closed }) => {
		const out: number[] = [];

		for (let i = points.length - 2; i >= 0; i -= 2) {
			out.push(points[i], points[i + 1]);
		}

		return { points: out, closed };
	});
}
