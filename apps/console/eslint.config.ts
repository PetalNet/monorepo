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
		name: "eslint/disable-type-checked-for-js",
		files: ["**/*.{js,cjs,mjs}"],
		...tseslint.configs.disableTypeChecked,
	},
	...oxlint.buildFromOxlintConfigFile(
		fileURLToPath(new URL("../../.oxlintrc.json", import.meta.url)),
	),
);
