import adapter from "@petalnet/svelte-ws";
import { websocket } from "@petalnet/svelte-ws/vite";
import { sentrySvelteKit } from "@sentry/sveltekit";
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
		include: ["src/**/*.spec.ts", "src/lib/server/**/*.test.ts", "test/**/*.test.ts"],
		fileParallelism: false,
		maxConcurrency: 1,
		sequence: { concurrent: false },
	},
	plugins: [
		websocket(),
		sentrySvelteKit({ telemetry: false }),
		tailwindcss(),
		fontless({
			families: [
				{ name: "Geist", provider: "fontsource", weights: [400, 500] },
				{ name: "Geist Mono", provider: "fontsource", weights: [400, 500] },
			],
			// The default ("font-prefixed-only") only scans --font-* custom properties, silently
			// skipping this app's --sans/--mono — no families detected, no @font-face emitted.
			processCSSVariables: true,
		}),
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
