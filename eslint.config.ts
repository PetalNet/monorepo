import * as path from "node:path";
import { fileURLToPath } from "node:url";

import js from "@eslint/js";
import json from "@eslint/json";
import markdown from "@eslint/markdown";
import oxlint from "eslint-plugin-oxlint";
import * as packageJson from "eslint-plugin-package-json/experimental";
import { defineConfig, includeIgnoreFile } from "eslint/config";
import tseslint from "typescript-eslint";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig([
	includeIgnoreFile(path.join(root, ".gitignore"), {
		gitignoreResolution: true,
	}),
	{
		// This root config is an untyped baseline that lints every workspace's files. Type-aware
		// eslint-disable directives (e.g. @typescript-eslint/no-deprecated) can't be evaluated
		// without type information here, so this pass must not adjudicate directive usage —
		// each workspace's own type-aware lint does, and would fail on a genuinely unused one.
		linterOptions: { reportUnusedDisableDirectives: "off" },
	},
	{
		files: ["**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx}"],
		extends: [js.configs.recommended, tseslint.configs.recommended],
	},
	{
		files: ["packages/better-auth-effect-qb-adapter/**/*.ts"],
		extends: tseslint.configs.strictTypeChecked,
		languageOptions: {
			parserOptions: {
				projectService: true,
			},
		},
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
	...oxlint.buildFromOxlintConfigFile(path.join(root, ".oxlintrc.json")),
]);
