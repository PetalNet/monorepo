import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { fontless } from "fontless";
import { defineConfig } from "vite";

export default defineConfig({
	ssr: { noExternal: ["fontless/runtime"] },
	plugins: [
		tailwindcss(),
		fontless({
			// The UI face is named only through --font-sans, so fontless must read custom properties.
			processCSSVariables: true,
			families: [{ name: "Geist", provider: "fontsource", weights: [400, 500, 600] }],
		}),
		sveltekit(),
	],
});
