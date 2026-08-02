import adapter from "@petalnet/svelte-ws";
import { websocket } from "@petalnet/svelte-ws/vite";
import { sentrySvelteKit } from "@sentry/sveltekit";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { fontless } from "fontless";
import { effect } from "svelte-effect-runtime";
import { ts } from "svelte-global-typescript";
import { defineConfig } from "vitest/config";

export default defineConfig({
	ssr: {
		external: ["better-auth"],
	},
	test: {
		include: ["src/**/*.spec.ts", "src/**/*.test.ts", "test/**/*.test.ts"],
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
		}),
		// SER's svelte-transform is a normal-order Vite transform, so it must precede the
		// SvelteKit plugin to lower `<script effect>` / yield* syntax before Svelte compiles.
		// `ts(true)` (svelte-global-typescript) likewise runs before sveltekit() for the build;
		// its matching preprocess is passed to sveltekit() below so editor tooling parses plain
		// <script> blocks as TypeScript (this SvelteKit build no longer reads svelte.config.js —
		// all config is passed directly to the sveltekit() plugin).
		...effect(),
		ts(true),
		sveltekit({
			adapter: adapter(),
			compilerOptions: { experimental: { async: true } },
			tracing: { server: true },
			experimental: { remoteFunctions: true },
		}),
	],
});
