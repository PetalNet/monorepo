import type { FontSource } from "$lib/render";

/** Reads the bundled font files on the server. Replaced by the render core. */
export const serverFonts: FontSource = {
	load() {
		return Promise.reject(new Error("serverFonts: not implemented yet"));
	},
};
