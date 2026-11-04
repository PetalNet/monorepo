import { access, readFile } from "node:fs/promises";
import path from "node:path";

import type { FontSource } from "$lib/render";

/** The first existing of `$LABEL_STUDIO_FONT_DIR`, the built client fonts and the source fonts. */
async function fontDir(): Promise<string> {
	const candidates = [process.env.LABEL_STUDIO_FONT_DIR, "build/client/fonts", "static/fonts"]
		.filter((dir): dir is string => Boolean(dir))
		.map((dir) => path.resolve(dir));
	const exists = await Promise.all(
		candidates.map(async (dir) =>
			access(dir).then(
				() => true,
				() => false,
			),
		),
	);
	const found = candidates.find((_, i) => exists[i]);

	if (!found) {
		throw new Error(`No font directory found; tried ${candidates.join(", ")}`);
	}

	return found;
}

let dir: Promise<string> | null = null;

/** Reads the bundled font files on the server. */
export const serverFonts: FontSource = {
	async load(file) {
		dir ??= fontDir();

		const root = await dir.catch((error: unknown) => {
			dir = null;

			throw error;
		});
		const resolved = path.resolve(root, file);

		if (!resolved.startsWith(root + path.sep)) {
			throw new Error(`Font path escapes the font directory: ${file}`);
		}

		const bytes = await readFile(resolved);

		return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	},
};
