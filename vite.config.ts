import { defineConfig } from "vite-plus";

export default defineConfig({
	fmt: {
		useTabs: true,
		singleQuote: false,
		semi: true,
		printWidth: 80,
		sortImports: true,
		sortTailwindcss: true,
		jsdoc: true,
		// package.json sorting is owned by eslint-plugin-package-json.
		ignorePatterns: ["**/package.json", "pnpm-lock.yaml"],
	},
});
