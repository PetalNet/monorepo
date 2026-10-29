import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { fontless } from "fontless";
import { defineConfig } from "vite";

export default defineConfig({
	ssr: { noExternal: ["fontless/runtime"] },
	plugins: [
		tailwindcss(),
		fontless({
			// The faces are named only through --font-sans and --font-serif, so fontless must read custom properties.
			processCSSVariables: true,
			families: [
				{ name: "Geist", provider: "fontsource", weights: [400, 500, 600] },
				{
					name: "EB Garamond",
					provider: "fontsource",
					weights: [400, 500, 600],
					styles: ["normal", "italic"],
				},
			],
		}),
		sveltekit(),
	],
});
