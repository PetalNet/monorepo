import path from "node:path";

import js from "@eslint/js";
import json from "@eslint/json";
import markdown from "@eslint/markdown";
import stylistic from "@stylistic/eslint-plugin";
import oxlint from "eslint-plugin-oxlint";
import * as packageJson from "eslint-plugin-package-json/experimental";
import svelte from "eslint-plugin-svelte";
import { defineConfig, includeIgnoreFile } from "eslint/config";
import tseslint from "typescript-eslint";

import { lintConfig } from "./oxlint.config.ts";

const root = import.meta.dirname;

const multilineStatements = [
	"multiline-block-like",
	"multiline-expression",
	"multiline-const",
	"multiline-let",
	"multiline-var",
] as const;

export default defineConfig([
	includeIgnoreFile(path.join(root, ".gitignore"), {
		gitignoreResolution: true,
	}),
	{
		ignores: [".agents/skills/impeccable/**"],
	},
	{
		files: ["**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx,svelte}"],
		plugins: { "@stylistic": stylistic },
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
			// Oxfmt preserves blank lines; ESLint enforces spacing around multiline statements.
			"@stylistic/padding-line-between-statements": [
				"error",
				{
					blankLine: "always",
					prev: "*",
					next: [...multilineStatements, "return", "break", "continue", "throw", "if"],
				},
				{ blankLine: "always", prev: [...multilineStatements, "const", "let"], next: "*" },
				// Consecutive declarations form a group, including multiline declarations.
				{ blankLine: "any", prev: ["const", "let", "var"], next: ["const", "let", "var"] },
				// Adjacent switch labels share a branch; spacing can imply accidental fallthrough.
				{ blankLine: "any", prev: ["case", "default"], next: ["case", "default"] },
				// Block-bodied functions and control flow retain prettier-plugin-padding-lines spacing.
				{
					blankLine: "always",
					prev: [
						"do",
						"for",
						"function",
						"if",
						"switch",
						"try",
						"while",
						{
							selector:
								'VariableDeclaration:has(> VariableDeclarator[init.type=/^(ArrowFunctionExpression|FunctionExpression)$/][init.body.type="BlockStatement"])',
						},
						{
							selector:
								'ExportNamedDeclaration:has(> VariableDeclaration:has(> VariableDeclarator[init.type=/^(ArrowFunctionExpression|FunctionExpression)$/][init.body.type="BlockStatement"]))',
						},
						{
							selector:
								':matches(ExportNamedDeclaration, ExportDefaultDeclaration)[declaration.type="FunctionDeclaration"]',
						},
						{
							selector:
								'ExpressionStatement[expression.type=/^(ArrowFunctionExpression|FunctionExpression)$/][expression.body.type="BlockStatement"]',
						},
					],
					next: "*",
				},
			],
			curly: ["error", "all"],
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
		files: ["apps/{collegemap,grove,slide,storybook,whoami}/**/*.svelte"],
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
		// test/tsconfig.json that both ESLint and native typed Oxlint can discover.
		files: ["packages/effect-api/test/**/*.ts", "packages/effect-sveltekit/test/**/*.ts"],
		languageOptions: {
			parserOptions: {
				projectService: false,
				tsconfigRootDir: root,
				project: [
					"packages/effect-api/test/tsconfig.json",
					"packages/effect-sveltekit/test/tsconfig.json",
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
		rules: {
			"package-json/require-description": "off",
			// Oxfmt owns property and collection ordering; keep validation and naming rules.
			"package-json/order-properties": "off",
			"package-json/sort-collections": "off",
		},
	},
	{
		files: ["**/tsconfig*.json"],
		plugins: { json },
		language: "json/jsonc",
		extends: [json.configs.recommended],
	},
	{
		files: ["apps/slide/**"],
		rules: {
			"@typescript-eslint/no-base-to-string": "off",
			"@typescript-eslint/no-confusing-void-expression": "off",
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/no-floating-promises": "off",
			"@typescript-eslint/no-misused-promises": "off",
			"@typescript-eslint/no-non-null-assertion": "off",
			"@typescript-eslint/no-unnecessary-condition": "off",
			"@typescript-eslint/no-unnecessary-type-conversion": "off",
			"@typescript-eslint/no-unsafe-argument": "off",
			"@typescript-eslint/no-unsafe-assignment": "off",
			"@typescript-eslint/no-unsafe-call": "off",
			"@typescript-eslint/no-unsafe-member-access": "off",
			"@typescript-eslint/no-unsafe-return": "off",
			"@typescript-eslint/no-unused-vars": "off",
			"@typescript-eslint/only-throw-error": "off",
			"@typescript-eslint/prefer-nullish-coalescing": "off",
			"@typescript-eslint/require-await": "off",
			"@typescript-eslint/restrict-plus-operands": "off",
			"@typescript-eslint/restrict-template-expressions": "off",
			"@typescript-eslint/use-unknown-in-catch-callback-variable": "off",
			"svelte/no-navigation-without-resolve": "off",
			"svelte/prefer-svelte-reactivity": "off",
			"svelte/require-each-key": "off",
		},
	},
	{
		name: "oxlint",
		ignores: ["**/*.svelte"],
		extends: oxlint
			// Effect has no ESLint counterparts; omit its preset from the bridge's narrower types.
			.buildFromOxlintConfig(
				{ ...structuredClone(lintConfig), extends: [] },
				{ typeAware: true, withNursery: true },
			)
			// ESLint owns its global ignores independently of Oxlint.
			.filter((config) => config.rules),
	},
]);
