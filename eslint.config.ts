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
			// Allow deliberate infinite loops written as `while (true)` (e.g. stream/redirect
			// pumps that break internally); the loop body still has to reach a break/return.
			"no-constant-condition": ["error", { checkLoops: false }],
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
	{
		// apps/console is slated for a rewrite, so its ~707 errors are not worth
		// fixing against code that is about to be replaced. It stays LINTED (never
		// ignored) with exactly the rules it currently trips turned off, so any new
		// rule violation still fails CI. Tracked in PetalNet/monorepo#337; delete
		// this block after the rewrite rather than growing it.
		files: ["apps/console/**"],
		rules: {
			"@typescript-eslint/dot-notation": "off",
			"@typescript-eslint/no-unsafe-member-access": "off",
			"@typescript-eslint/require-await": "off",
			"@typescript-eslint/prefer-nullish-coalescing": "off",
			"@typescript-eslint/no-unsafe-assignment": "off",
			"@typescript-eslint/non-nullable-type-assertion-style": "off",
			"@typescript-eslint/no-empty-function": "off",
			"@typescript-eslint/no-non-null-assertion": "off",
			"@typescript-eslint/await-thenable": "off",
			"@typescript-eslint/no-confusing-void-expression": "off",
			"@typescript-eslint/no-unnecessary-condition": "off",
			"@typescript-eslint/no-base-to-string": "off",
			"@typescript-eslint/no-unsafe-argument": "off",
			"@typescript-eslint/no-unnecessary-type-assertion": "off",
			"@typescript-eslint/prefer-optional-chain": "off",
			"@typescript-eslint/array-type": "off",
			"@typescript-eslint/no-unnecessary-type-conversion": "off",
			"@typescript-eslint/consistent-type-definitions": "off",
			"@typescript-eslint/restrict-plus-operands": "off",
			"@typescript-eslint/no-unsafe-call": "off",
			"@typescript-eslint/no-unnecessary-type-parameters": "off",
			"@typescript-eslint/consistent-indexed-object-style": "off",
			"@typescript-eslint/restrict-template-expressions": "off",
			"@typescript-eslint/no-unsafe-return": "off",
		},
	},
	...oxlint.buildFromOxlintConfigFile(path.join(root, ".oxlintrc.json")),
]);
