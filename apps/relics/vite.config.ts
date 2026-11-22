import adapter from "@sveltejs/adapter-node";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { fontless } from "fontless";
import { defineConfig } from "vitest/config";

export default defineConfig({
	ssr: { noExternal: ["fontless/runtime"] },
	plugins: [
		tailwindcss(),
		fontless({
			defaults: { preload: true },
			families: [
				{
					name: "Nunito",
					provider: "fontsource",
					weights: [400, 700],
					global: true,
				},
				{ name: "Lora", provider: "fontsource", weights: [500], global: true },
				{ name: "Patrick Hand", provider: "fontsource", weights: [400], global: true },
			],
		}),
		sveltekit({ adapter: adapter() }),
	],
	build: { cssTarget: ["chrome123", "firefox120", "safari17.5"] },
	test: { include: ["src/**/*.test.ts"] },
});
