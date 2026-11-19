import adapter from "@sveltejs/adapter-node";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { fontless } from "fontless";
import { defineConfig } from "vite";

export default defineConfig({
	build: {
		// Keep light-dark() as written: its media-query fallback ignores the theme toggle.
		cssTarget: ["chrome123", "firefox120", "safari17.5"],
	},
	ssr: { noExternal: ["fontless/runtime"] },
	plugins: [
		tailwindcss(),
		fontless({
			// The faces are named only through --font-sans and --font-mono.
			processCSSVariables: true,
			families: [
				{ name: "Geist", provider: "fontsource", weights: [300, 400, 500] },
				{ name: "Geist Mono", provider: "fontsource", weights: [400] },
			],
		}),
		sveltekit({ adapter: adapter() }),
	],
});
