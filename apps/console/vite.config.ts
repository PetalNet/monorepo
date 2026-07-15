import { sentrySvelteKit } from "@sentry/sveltekit";
import adapter from "@sveltejs/adapter-node";
import { effect } from "svelte-effect-runtime";
import { ts } from "svelte-global-typescript";
import { compose, kit } from "svelte-plugin-composer";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		fileParallelism: false,
		maxConcurrency: 1,
		sequence: { concurrent: false },
	},
	plugins: [
		effect(),
		sentrySvelteKit({ telemetry: false }),
		...compose([
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
