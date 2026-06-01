import { defineConfig } from "vite-plus";

export default defineConfig({
	run: {
		// Cache package.json scripts so unchanged non-emitting tasks (lint, fmt,
		// check) are skipped. We deliberately do NOT move build/typecheck into
		// run.tasks: vp's auto-input fingerprint captures the files those tasks
		// WRITE (tsbuildinfo, dist), so emit-heavy tasks don't cache-hit anyway
		// (voidzero-dev/vite-plus#1187). Revisit once that's fixed; for now keep
		// ergonomic package.json scripts rather than a per-package run.tasks split.
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
		// package.json sorting is owned by eslint-plugin-package-json.
		ignorePatterns: ["**/package.json", "pnpm-lock.yaml"],
	},
});
