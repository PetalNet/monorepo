import { sentrySvelteKit } from "@sentry/sveltekit";
import adapter from "@sveltejs/adapter-node";
import tailwindcss from "@tailwindcss/vite";
import { fontless } from "fontless";
import { effect } from "svelte-effect-runtime";
import { ts } from "svelte-global-typescript";
import { compose, kit } from "svelte-plugin-composer";
import { defineConfig } from "vitest/config";

export default defineConfig({
	ssr: {
		external: ["better-auth"],
	},
	test: {
		fileParallelism: false,
		maxConcurrency: 1,
		sequence: { concurrent: false },
	},
	plugins: [
		sentrySvelteKit({ telemetry: false }),
		tailwindcss(),
		fontless({ families: [
			{ name: "Geist", provider: "fontsource", weights: [400, 500] },
			{ name: "Geist Mono", provider: "fontsource", weights: [400, 500] },
		] }),
		...compose([
			effect(),
			ts(true),
		kit({
			adapter: adapter(),
			compilerOptions: { experimental: { async: true } },
			kit: {
				tracing: { server: true },
				experimental: {
					remoteFunctions: true,
				},
			},
		}),
		]),
	],
});
