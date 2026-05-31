import { defineConfig } from "vite-plus";

export default defineConfig({
	run: {
		// Cache package.json script tasks (build/typecheck/check/lint/...) with
		// vp's automatic file-tracking, so unchanged work is skipped.
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
