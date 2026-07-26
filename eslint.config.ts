import * as path from "node:path";
import { fileURLToPath } from "node:url";

import js from "@eslint/js";
import json from "@eslint/json";
import markdown from "@eslint/markdown";
import oxlint from "eslint-plugin-oxlint";
import * as packageJson from "eslint-plugin-package-json/experimental";
import svelte from "eslint-plugin-svelte";
import { defineConfig, includeIgnoreFile } from "eslint/config";
import tseslint from "typescript-eslint";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig([
	includeIgnoreFile(path.join(root, ".gitignore"), {
		gitignoreResolution: true,
	}),
	{
		// apps/console is slated for a rewrite; excluded from ESLint rather than
		// fixed/partially-disabled. Re-enable after the rewrite -- see PetalNet/monorepo#337.
		ignores: ["apps/console/**"],
	},
	{
		files: ["**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx,svelte}"],
		extends: [
			js.configs.recommended,
			tseslint.configs.strictTypeChecked,
			tseslint.configs.stylisticTypeChecked,
		],
		languageOptions: {
			parserOptions: {
				projectService: true,
			},
		},
		rules: { "no-undef": "off" },
	},
	{
		files: ["apps/{collegemap,console,grove,slide}/**/*.svelte"],
		extends: svelte.configs.recommended,
		languageOptions: {
			parserOptions: {
				parser: tseslint.parser,
				projectService: true,
				extraFileExtensions: [".svelte"],
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
	{
		// apps/slide carries heavy untyped-value debt (~769 of its errors are the
		// no-unsafe-* cascade). These rules are disabled ONLY for slide and tracked
		// for a real typing pass -- see PetalNet/monorepo#336. Do not extend this to
		// other packages; fix those at the source instead.
		files: ["apps/slide/**"],
		rules: {
			"@typescript-eslint/no-unsafe-member-access": "off",
			"@typescript-eslint/no-unsafe-assignment": "off",
			"@typescript-eslint/no-unsafe-call": "off",
			"@typescript-eslint/no-unsafe-argument": "off",
			"@typescript-eslint/no-unsafe-return": "off",
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/prefer-nullish-coalescing": "off",
			"@typescript-eslint/restrict-template-expressions": "off",
			"@typescript-eslint/restrict-plus-operands": "off",
			"@typescript-eslint/no-unused-vars": "off",
			"@typescript-eslint/no-floating-promises": "off",
			"@typescript-eslint/no-misused-promises": "off",
			"@typescript-eslint/only-throw-error": "off",
			"@typescript-eslint/no-unnecessary-condition": "off",
			"@typescript-eslint/require-await": "off",
			"@typescript-eslint/no-base-to-string": "off",
			"@typescript-eslint/no-confusing-void-expression": "off",
			"@typescript-eslint/no-unnecessary-type-conversion": "off",
			"svelte/require-each-key": "off",
			"svelte/no-navigation-without-resolve": "off",
			"@typescript-eslint/no-non-null-assertion": "off",
			"@typescript-eslint/no-redundant-type-constituents": "off",
			"@typescript-eslint/use-unknown-in-catch-callback-variable": "off",
			"svelte/prefer-svelte-reactivity": "off",
		},
	},
	...oxlint.buildFromOxlintConfigFile(path.join(root, ".oxlintrc.json")),
]);
