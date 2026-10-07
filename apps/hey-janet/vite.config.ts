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
					name: "Geist",
					src: "/fonts/geist-variable.woff2",
					weight: "100 900",
					style: "normal",
					fallbacks: ["Arial"],
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
