import { defineConfig } from "vite-plus";

export default defineConfig({
	run: {
		// Cache package.json scripts so unchanged non-emitting tasks (lint, fmt,
		// check) are skipped. We deliberately do NOT move build/typecheck into
		// run.tasks: it doesn't support customizing them per-directory.
		cache: {
			scripts: true,
		},
	},
	fmt: {
		useTabs: true,
		singleQuote: false,
		semi: true,
		sortImports: true,
		sortTailwindcss: true,
		jsdoc: true,
		svelte: true,
		// package.json sorting is owned by eslint-plugin-package-json.
		// apps/point/docs/design: vendored design references (the client UI spec
		// + the pixel-close mockup target) — kept byte-faithful, not reformatted.
		// drizzle-kit generate emits these and does not know about the formatter, so every
		// new migration would otherwise fail fmt until someone remembered a manual pass.
		ignorePatterns: [
			"**/package.json",
			"pnpm-lock.yaml",
			"apps/point/docs/design/**",
			"apps/*/drizzle/meta/**",
		],
	},
});
