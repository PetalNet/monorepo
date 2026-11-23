import adapter from "@sveltejs/adapter-node";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { fontless } from "fontless";
import { defineConfig } from "vitest/config";

export default defineConfig({
	ssr: { noExternal: ["fontless/runtime"] },
	plugins: [
		tailwindcss(),
		fontless({ processCSSVariables: true }),
		sveltekit({ adapter: adapter() }),
	],
	test: {
		include: ["src/**/*.test.ts"],
		environment: "node",
	},
});
