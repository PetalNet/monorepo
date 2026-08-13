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
		ignores: [".agents/skills/impeccable/**"],
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
		rules: {
			"no-undef": "off",
			"no-constant-condition": "off",
			"@typescript-eslint/no-unnecessary-condition": [
				"error",
				{
					allowConstantLoopConditions: "only-allowed-literals",
					checkTypePredicates: true,
				},
			],
		},
	},
	{
		files: ["apps/grove/dev-oidc.mjs", "apps/grove/scripts/**/*.mjs"],
		extends: [tseslint.configs.disableTypeChecked],
		languageOptions: {
			parserOptions: {
				projectService: false,
			},
		},
	},
	{
		files: ["apps/{collegemap,console,grove,slide,storybook}/**/*.svelte"],
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
		files: ["apps/grove/**/*.{ts,svelte}"],
		rules: {
			"@typescript-eslint/no-restricted-types": [
				"error",
				{
					types: {
						Parameters: "Reference the parameter type directly.",
						ReturnType: "Reference the return type directly.",
					},
				},
			],
		},
	},
	{
		// The effect-api/effect-sveltekit build tsconfigs intentionally scope emit to
		// src (emitDeclarationOnly + rootDir), so their test/ files are not part of the
		// build project. Point typed linting for those tests at a dedicated
		// tsconfig.eslint.json that includes src + test (see each package).
		files: ["packages/effect-api/test/**/*.ts", "packages/effect-sveltekit/test/**/*.ts"],
		languageOptions: {
			parserOptions: {
				projectService: false,
				tsconfigRootDir: root,
				project: [
					"packages/effect-api/tsconfig.eslint.json",
					"packages/effect-sveltekit/tsconfig.eslint.json",
				],
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
		files: ["apps/{slide,console}/**"],
		rules: {
			"@typescript-eslint/dot-notation": "off",
			"@typescript-eslint/array-type": "off",
			"@typescript-eslint/await-thenable": "off",
			"@typescript-eslint/consistent-indexed-object-style": "off",
			"@typescript-eslint/consistent-type-definitions": "off",
			"@typescript-eslint/no-base-to-string": "off",
			"@typescript-eslint/no-confusing-void-expression": "off",
			"@typescript-eslint/no-empty-function": "off",
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/no-floating-promises": "off",
			"@typescript-eslint/no-misused-promises": "off",
			"@typescript-eslint/no-non-null-assertion": "off",
			"@typescript-eslint/no-redundant-type-constituents": "off",
			"@typescript-eslint/no-unnecessary-condition": "off",
			"@typescript-eslint/no-unnecessary-type-assertion": "off",
			"@typescript-eslint/no-unnecessary-type-conversion": "off",
			"@typescript-eslint/no-unnecessary-type-parameters": "off",
			"@typescript-eslint/no-unsafe-argument": "off",
			"@typescript-eslint/no-unsafe-assignment": "off",
			"@typescript-eslint/no-unsafe-call": "off",
			"@typescript-eslint/no-unsafe-member-access": "off",
			"@typescript-eslint/no-unsafe-return": "off",
			"@typescript-eslint/no-unused-vars": "off",
			"@typescript-eslint/non-nullable-type-assertion-style": "off",
			"@typescript-eslint/only-throw-error": "off",
			"@typescript-eslint/prefer-nullish-coalescing": "off",
			"@typescript-eslint/prefer-optional-chain": "off",
			"@typescript-eslint/require-await": "off",
			"@typescript-eslint/restrict-plus-operands": "off",
			"@typescript-eslint/restrict-template-expressions": "off",
			"@typescript-eslint/use-unknown-in-catch-callback-variable": "off",
			"svelte/no-navigation-without-resolve": "off",
			"svelte/prefer-svelte-reactivity": "off",
			"svelte/require-each-key": "off",
		},
	},
	...oxlint.buildFromOxlintConfigFile(path.join(root, ".oxlintrc.json")),
]);
