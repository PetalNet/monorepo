import { fileURLToPath } from "node:url";

import svelte from "eslint-plugin-svelte";
import oxlint from "eslint-plugin-oxlint";
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
	...oxlint.buildFromOxlintConfigFile(fileURLToPath(new URL("../../.oxlintrc.json", import.meta.url))),
);
