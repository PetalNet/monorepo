import { fileURLToPath } from "node:url";

import oxlint from "eslint-plugin-oxlint";
import svelte from "eslint-plugin-svelte";
import tseslint from "typescript-eslint";

const typedFiles = ["**/*.{ts,svelte}"];

export default tseslint.config(
	{ ignores: [".svelte-kit/**", "build/**"] },
	...tseslint.configs.strictTypeChecked,
	...svelte.configs.recommended,
	{
		name: "eslint/type-aware-rules",
		files: typedFiles,
		languageOptions: {
			parserOptions: {
				parser: tseslint.parser,
				projectService: true,
				extraFileExtensions: [".svelte"],
			},
		},
	},
	{
		// import-in-the-middle 2.x registers its off-thread ESM loader hook via
		// `module.register("import-in-the-middle/hook.mjs", ...)`. @types/node marks that API
		// @deprecated in favour of `module.registerHooks()`, but registerHooks is a different,
		// synchronous in-thread mechanism that cannot load hook.mjs, and IITM exposes no
		// registerHooks-compatible entry point. register() is therefore the only supported path,
		// so no-deprecated is a false positive scoped off for this single file only.
		name: "eslint/otel-iitm-register",
		files: ["src/instrumentation.server.ts"],
		rules: { "@typescript-eslint/no-deprecated": "off" },
	},
	...oxlint.buildFromOxlintConfigFile(
		fileURLToPath(new URL("../../.oxlintrc.json", import.meta.url)),
	),
);
