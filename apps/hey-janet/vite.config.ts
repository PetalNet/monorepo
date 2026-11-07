import adapter from "@sveltejs/adapter-node";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { fontless } from "fontless";
import { defineConfig } from "vite";
export default defineConfig({
	plugins: [
		fontless({
			families: [
				{
					name: "Public Sans",
					provider: "fontsource",
					weights: [400, 500, 600],
					styles: ["normal"],
					preload: true,
				},
			],
		}),
		tailwindcss(),
		sveltekit({
			adapter: adapter(),
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes("node_modules") ? undefined : true,
			},
		}),
	],
});
