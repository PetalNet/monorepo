import type { FontSource } from "$lib/render";

const cache = new Map<string, Promise<ArrayBuffer>>();

/** The browser fetches the same font files the server reads, once each. */
export const browserFonts: FontSource = {
	load(file) {
		let pending = cache.get(file);

		if (!pending) {
			pending = fetch(`/fonts/${file}`).then(async (response) => {
				if (!response.ok) {
					throw new Error(`Font ${file} failed to load (${String(response.status)})`);
				}

				return response.arrayBuffer();
			});

			pending.catch(() => cache.delete(file));
			cache.set(file, pending);
		}

		return pending;
	},
};
