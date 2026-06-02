import * as path from "node:path";

import js from "@eslint/js";
import json from "@eslint/json";
import markdown from "@eslint/markdown";
import oxlint from "eslint-plugin-oxlint";
import * as packageJson from "eslint-plugin-package-json/experimental";
import { defineConfig, includeIgnoreFile } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
	includeIgnoreFile(path.resolve(".gitignore"), {
		gitignoreResolution: true,
	}),
	{
		files: ["**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx}"],
		extends: [js.configs.recommended, tseslint.configs.recommended],
	},
	{
		files: ["**/*.md"],
		plugins: { markdown },
		language: "markdown/gfm",
		languageOptions: {
			frontmatter: "yaml",
		},
		extends: [markdown.configs.recommended],
	},
	{
		files: [".github/**/*.md"],
		rules: {
			"markdown/heading-increment": "off",
		},
	},
	{
		files: ["**/*.json"],
		plugins: { json },
		language: "json/json",
		extends: [json.configs.recommended],
	},
	{
		files: ["**/package.json"],
		extends: [packageJson.configs.recommended, packageJson.configs.stylistic],
		rules: { "package-json/require-description": "off" },
	},
	{
		files: ["**/tsconfig*.json"],
		plugins: { json },
		language: "json/jsonc",
		extends: [json.configs.recommended],
	},
	...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
]);
