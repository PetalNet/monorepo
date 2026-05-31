import json from "@eslint/json";
import markdown from "@eslint/markdown";
import pluginOxlint from "eslint-plugin-oxlint";
import { configs as packageJsonConfigs } from "eslint-plugin-package-json";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
	{
		ignores: [
			"**/dist/**",
			"**/build/**",
			"**/.svelte-kit/**",
			"**/node_modules/**",
			"**/coverage/**",
			"apps/*/dist/**",
			"pnpm-lock.yaml",
		],
	},
	{
		files: ["**/*.{js,mjs,cjs}"],
		languageOptions: {
			ecmaVersion: "latest",
			sourceType: "module",
		},
	},
	{
		files: ["**/*.{ts,mts,cts}"],
		languageOptions: {
			parser: tseslint.parser,
			ecmaVersion: "latest",
			sourceType: "module",
		},
	},
	{
		files: ["**/*.md"],
		plugins: { markdown },
		language: "markdown/gfm",
		rules: {
			"markdown/no-empty-links": "error",
			"markdown/no-invalid-label-refs": "error",
		},
	},
	{
		files: ["**/*.json"],
		ignores: ["**/package.json", "**/tsconfig*.json"],
		plugins: { json },
		language: "json/json",
		rules: {
			"json/no-duplicate-keys": "error",
		},
	},
	{
		files: ["**/tsconfig*.json"],
		plugins: { json },
		language: "json/jsonc",
		rules: {
			"json/no-duplicate-keys": "error",
		},
	},
	packageJsonConfigs.recommended,
	{
		// Why: these are private internal packages — no description/license required.
		files: ["**/package.json"],
		rules: { "package-json/require-description": "off" },
	},
	// Why last: eslint-plugin-oxlint disables rules already covered by oxlint
	// so the two linters don't double-report.
	...pluginOxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
]);
