import type { Bitmap, ImageElement } from "$lib/doc";

/** Decode the element's base64 luminance, or explain why it can't be used. */
export function decodeGray(el: ImageElement): Uint8Array | string {
	if (!(el.srcW > 0 && el.srcH > 0 && Number.isInteger(el.srcW) && Number.isInteger(el.srcH))) {
		return "Image has no pixels";
	}

	let binary: string;

	try {
		binary = atob(el.gray);
	} catch {
		return "Image data is not valid base64";
	}

	if (binary.length !== el.srcW * el.srcH) {
		return `Image data has ${String(binary.length)} pixels, expected ${String(el.srcW)}×${String(el.srcH)}`;
	}

	const out = new Uint8Array(binary.length);

	for (let i = 0; i < binary.length; i++) {
		out[i] = binary.codePointAt(i) ?? 0;
	}

	return out;
}

/** For each destination pixel, the source pixels it covers and their area weights. */
function taps(
	destSize: number,
	offset: number,
	scale: number,
	srcSize: number,
): { index: number[]; weight: number[] }[] {
	return Array.from({ length: destSize }, (_, d) => {
		const from = Math.max(0, (d - offset) / scale);
		const to = Math.min(srcSize, (d + 1 - offset) / scale);
		const index: number[] = [];
		const weight: number[] = [];

		for (let s = Math.floor(from); s < to; s++) {
			const w = Math.min(to, s + 1) - Math.max(from, s);

			if (w > 0) {
				index.push(s);
				weight.push(w);
			}
		}

		return { index, weight };
	});
}

/**
 * Resample to the `w × h` pixel layer with an exact box filter (area average when shrinking), then
 * emit ink: grayscale in design mode, thresholded or Floyd–Steinberg dithered in print mode. Pixels
 * the image doesn't cover stay paper.
 */
export function drawImage(
	target: Bitmap,
	el: ImageElement,
	gray: Uint8Array,
	mode: "print" | "design",
): void {
	const { width: w, height: h } = target;
	const sx0 = w / el.srcW;
	const sy0 = h / el.srcH;
	const uniform = el.fit === "contain" ? Math.min(sx0, sy0) : Math.max(sx0, sy0);
	const sx = el.fit === "stretch" ? sx0 : uniform;
	const sy = el.fit === "stretch" ? sy0 : uniform;
	const ox = (w - el.srcW * sx) / 2;
	const oy = (h - el.srcH * sy) / 2;
	const cols = taps(w, ox, sx, el.srcW);
	const rows = taps(h, oy, sy, el.srcH);
	const lum = new Float32Array(w * h);
	const covered = new Uint8Array(w * h);

	for (let y = 0; y < h; y++) {
		const row = rows[y];

		for (let x = 0; x < w; x++) {
			const col = cols[x];
			let sum = 0;
			let area = 0;

			for (let j = 0; j < row.index.length; j++) {
				const base = row.index[j] * el.srcW;

				for (let i = 0; i < col.index.length; i++) {
					const a = row.weight[j] * col.weight[i];

					sum += gray[base + col.index[i]] * a;
					area += a;
				}
			}

			if (area > 0) {
				lum[y * w + x] = sum / area;
				covered[y * w + x] = 1;
			}
		}
	}

	if (mode === "design") {
		for (let i = 0; i < lum.length; i++) {
			if (covered[i]) {
				target.data[i] = Math.round(255 - lum[i]);
			}
		}

		return;
	}

	if (el.mode === "threshold") {
		for (let i = 0; i < lum.length; i++) {
			if (covered[i]) {
				target.data[i] = lum[i] < el.threshold ? 255 : 0;
			}
		}

		return;
	}

	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = y * w + x;

			if (!covered[i]) {
				continue;
			}

			const old = lum[i];
			const printed = old < el.threshold;
			const error = old - (printed ? 0 : 255);

			target.data[i] = printed ? 255 : 0;

			const spread = (dx: number, dy: number, share: number): void => {
				const nx = x + dx;
				const ny = y + dy;

				if (nx >= 0 && nx < w && ny < h && covered[ny * w + nx]) {
					lum[ny * w + nx] += error * share;
				}
			};

			spread(1, 0, 7 / 16);
			spread(-1, 1, 3 / 16);
			spread(0, 1, 5 / 16);
			spread(1, 1, 1 / 16);
		}
	}
}
