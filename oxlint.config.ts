import { recommended } from "@effect/tsgo/oxlint-presets";
import type { OxlintConfig } from "oxlint";

export const lintConfig = {
	extends: [recommended],
	options: { typeAware: true },
	plugins: ["typescript", "unicorn", "node", "promise", "effecttsgo"],
	categories: {
		correctness: "error",
		suspicious: "warn",
		perf: "warn",
		style: "warn",
		pedantic: "warn",
	},
	rules: {
		// Preserve the stricter options of rules transferred from typed ESLint.
		"typescript/no-unnecessary-condition": [
			"error",
			{ allowConstantLoopConditions: "only-allowed-literals", checkTypePredicates: true },
		],
		"typescript/restrict-plus-operands": [
			"error",
			{
				allowAny: false,
				allowBoolean: false,
				allowNullish: false,
				allowNumberAndString: false,
				allowRegExp: false,
			},
		],
		"typescript/restrict-template-expressions": [
			"error",
			{
				allowAny: false,
				allowBoolean: false,
				allowNever: false,
				allowNullish: false,
				allowNumber: false,
				allowRegExp: false,
			},
		],
		"typescript/return-await": ["error", "error-handling-correctness-only"],
		"no-useless-rename": "error",
		"operator-assignment": "error",
		"prefer-object-spread": "error",
		"prefer-regex-literals": "error",
		"eslint/eqeqeq": ["error", "smart"],
		"eslint/no-underscore-dangle": "error",
		"eslint/no-restricted-imports": [
			"error",
			{
				patterns: [
					{
						group: ["crypto", "node:crypto"],
						importNames: ["default", "randomUUID", "getRandomValues", "webcrypto"],
						message: "Use the global crypto object.",
					},
					{
						group: ["util", "node:util"],
						importNames: ["default", "TextEncoder", "TextDecoder"],
						message: "Use the Web globals TextEncoder and TextDecoder.",
					},
					{
						group: ["url", "node:url"],
						importNames: ["default", "URL", "URLSearchParams"],
						message: "Use the Web globals URL and URLSearchParams.",
					},
				],
			},
		],
		"unicorn/import-style": "error",
		"eslint/curly": ["error", "all"],
		// Domain failures use Effect error classes and schema-aware checks.
		"effecttsgo/extends-native-error": "error",
		"effecttsgo/instance-of-schema": "error",
		// A conditional radix of 16 or 10 is valid, but the rule cannot prove it.
		"eslint/radix": "off",
		// Size limits and presentation preferences are too noisy for this workspace.
		"eslint/max-classes-per-file": "off",
		"eslint/max-depth": "off",
		"eslint/max-lines": "off",
		"eslint/max-lines-per-function": "off",
		"eslint/no-inline-comments": "off",
		"eslint/require-unicode-regexp": "off",
		// TypeScript's counterparts understand overloads and Promise-returning async functions.
		"eslint/no-redeclare": "off",
		"eslint/require-await": "off",
		// These opt-in typed policies require a separate contract/style migration.
		"typescript/prefer-readonly-parameter-types": "off",
		"typescript/strict-boolean-expressions": "off",
		"typescript/strict-void-return": "off",
		"typescript/consistent-return": "off",
		"typescript/no-unsafe-type-assertion": "off",
		"unicorn/no-array-callback-reference": "off",
		"unicorn/no-object-as-default-parameter": "off",
		"unicorn/no-typeof-undefined": "off",
		"unicorn/no-useless-undefined": "off",
		// Array#at adds undefined to the type even for known non-empty arrays.
		"unicorn/prefer-at": "off",
		"unicorn/prefer-number-coercion": "off",
		"unicorn/prefer-string-replace-all": "off",
		// Hoisting callbacks can change listener identity; preserve declaration locality.
		"unicorn/consistent-function-scoping": "off",
		// Categories must not opt into Effect rules outside its recommended preset.
		"effecttsgo/any-unknown-in-error-context": "off",
		"effecttsgo/strict-effect-provide": "off",
		// Formatter-owned ordering and broad style bans conflict with established code.
		"eslint/capitalized-comments": "off",
		"eslint/func-names": "off",
		"eslint/func-style": "off",
		"eslint/id-length": "off",
		"eslint/init-declarations": "off",
		"eslint/max-params": "off",
		"eslint/max-statements": "off",
		"eslint/new-cap": "off",
		"eslint/no-continue": "off",
		"eslint/no-duplicate-imports": "off",
		"eslint/no-magic-numbers": "off",
		"eslint/no-nested-ternary": "off",
		"eslint/no-ternary": "off",
		"eslint/one-var": "off",
		"eslint/prefer-destructuring": "off",
		"eslint/prefer-named-capture-group": "off",
		"eslint/sort-imports": "off",
		"eslint/sort-keys": "off",
		"node/no-sync": "off",
		"promise/avoid-new": "off",
		"promise/prefer-await-to-callbacks": "off",
		"promise/prefer-await-to-then": "off",
		"typescript/parameter-properties": "off",
		"unicorn/custom-error-definition": "off",
		// Domain-specific names such as defect distinguish caught failures.
		"unicorn/catch-error-name": "off",
		"unicorn/filename-case": "off",
		"unicorn/max-nested-calls": "off",
		"unicorn/no-array-method-this-argument": "off",
		"unicorn/no-await-expression-member": "off",
		"unicorn/no-nested-ternary": "off",
		"unicorn/no-null": "off",
		"unicorn/number-literal-case": "off",
		"unicorn/numeric-separators-style": "off",
		"unicorn/prefer-global-this": "off",
		"unicorn/prefer-spread": "off",
		"unicorn/prefer-string-raw": "off",
		"unicorn/prefer-ternary": "off",
		"unicorn/switch-case-braces": "off",
		// Keep Effect's recommended policy rather than enabling every opt-in style rule.
		"effecttsgo/deterministic-keys": "off",
		"effecttsgo/missed-pipeable-opportunity": "off",
		"effecttsgo/missing-pipeable-signature": "off",
		"effecttsgo/new-schema-class": "off",
		"effecttsgo/service-not-as-class": "off",
		"effecttsgo/strict-boolean-expressions": "off",
	},
	overrides: [
		{
			// Effect owns asynchronous control flow; framework Promise adapters stay at the boundary.
			files: [
				"apps/grove/dev-oidc.ts",
				"apps/grove/src/lib/server/{actors,sprouts,projects}/**",
				"packages/effect-api/src/**",
			],
			rules: {
				"effecttsgo/async-function": "error",
				"effecttsgo/new-promise": "error",
			},
		},
		{
			files: ["apps/grove/src/lib/server/projects/**"],
			rules: { "effecttsgo/prefer-schema-over-json": "error" },
		},
		{
			files: ["apps/grove/dev-oidc.ts"],
			rules: {
				"effecttsgo/any-unknown-in-error-context": "error",
				"effecttsgo/global-console": "error",
				"effecttsgo/global-date": "error",
				"effecttsgo/global-fetch": "error",
				"effecttsgo/global-timers": "error",
				"effecttsgo/prefer-schema-over-json": "error",
				"effecttsgo/process-env": "error",
			},
		},
		{
			files: ["apps/slide/**"],
			// Slide's rewrite owns type-safety debt and deprecated framework configuration.
			rules: {
				"typescript/no-base-to-string": "off",
				"typescript/no-deprecated": "off",
				"typescript/no-unnecessary-condition": "off",
				"typescript/no-unsafe-argument": "off",
				"typescript/no-unsafe-assignment": "off",
				"typescript/no-unsafe-call": "off",
				"typescript/no-unsafe-member-access": "off",
				"typescript/only-throw-error": "off",
				"typescript/prefer-nullish-coalescing": "off",
				"typescript/require-await": "off",
				"typescript/restrict-template-expressions": "off",
			},
		},
	],
	ignorePatterns: [
		".agents/skills/impeccable/**",
		// ESLint owns framework/template-aware checking.
		"**/*.svelte",
		"**/dist/**",
		"**/build/**",
		"**/.svelte-kit/**",
		"**/node_modules/**",
		"**/coverage/**",
		"**/.turbo/**",
	],
} satisfies OxlintConfig;

export default lintConfig;
