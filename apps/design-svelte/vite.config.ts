import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [sveltekit()],
	build: {
		rollupOptions: {
			// The ProseMark bundle is a static runtime asset served from /vendor; it's
			// never part of the module graph (lazy-imported on demand). Mark it
			// external so the bundler leaves the dynamic import() untouched.
			external: ["/vendor/prosemark.bundle.js"],
		},
	},
});
