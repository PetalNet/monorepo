import adapter from "@sveltejs/adapter-node";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { fontless } from "fontless";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		tailwindcss(),
		fontless({
			families: [{ name: "Geist", provider: "fontsource", weights: [400, 500, 600], global: true }],
		}),
		sveltekit({ adapter: adapter() }),
	],
	build: { cssTarget: ["chrome123", "firefox120", "safari17.5"] },
	test: { include: ["src/**/*.test.ts"] },
});
