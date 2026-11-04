/** Longest side of an imported image, in source pixels. */
export const MAX_IMAGE_SIDE = 1024;

export function fitSize(
	width: number,
	height: number,
	max = MAX_IMAGE_SIDE,
): { w: number; h: number } {
	const scale = Math.min(1, max / Math.max(width, height));

	return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) };
}

/**
 * RGBA to luminance (Rec. 709), composited over white so transparent pixels become paper instead of
 * ink.
 */
export function toGray(rgba: Uint8ClampedArray): Uint8Array {
	const gray = new Uint8Array(rgba.length / 4);

	for (let index = 0; index < gray.length; index++) {
		const offset = index * 4;
		const alpha = rgba[offset + 3] / 255;
		const luma = 0.2126 * rgba[offset] + 0.7152 * rgba[offset + 1] + 0.0722 * rgba[offset + 2];

		gray[index] = Math.round(luma * alpha + 255 * (1 - alpha));
	}

	return gray;
}

export function toBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;

	for (let index = 0; index < bytes.length; index += chunk) {
		binary += String.fromCodePoint(...bytes.subarray(index, index + chunk));
	}

	return btoa(binary);
}

/** Decode an image file in the browser into capped grayscale. */
export async function importImage(
	blob: Blob,
): Promise<{ gray: string; srcW: number; srcH: number }> {
	const bitmap = await createImageBitmap(blob);
	const { w, h } = fitSize(bitmap.width, bitmap.height);
	const canvas = new OffscreenCanvas(w, h);
	const context = canvas.getContext("2d");

	if (!context) {
		throw new Error("This browser cannot decode images");
	}

	context.drawImage(bitmap, 0, 0, w, h);
	bitmap.close();
	const gray = toGray(context.getImageData(0, 0, w, h).data);

	return { gray: toBase64(gray), srcW: w, srcH: h };
}
