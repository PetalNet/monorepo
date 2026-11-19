import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	// Component tests mount Svelte in happy-dom, which needs the browser build.
	resolve: process.env.VITEST ? { conditions: ["browser"] } : undefined,
});
