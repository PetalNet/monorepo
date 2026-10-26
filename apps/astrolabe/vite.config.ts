import adapter from "@sveltejs/adapter-node";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { fontless } from "fontless";
import { defineConfig } from "vite";

export default defineConfig({
	ssr: { noExternal: ["fontless/runtime"] },
	plugins: [
		tailwindcss(),
		fontless({
			families: [
				{
					name: "Geist",
					src: "https://cdn.jsdelivr.net/npm/geist@1.5.1/dist/fonts/geist-sans/Geist-Variable.woff2",
					weight: "100 900",
					global: true,
				},
				{
					name: "Geist Mono",
					src: "https://cdn.jsdelivr.net/npm/geist@1.5.1/dist/fonts/geist-mono/GeistMono-Variable.woff2",
					weight: "100 900",
					global: true,
				},
			],
		}),
		sveltekit({ adapter: adapter() }),
	],
});
