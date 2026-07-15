import { fileURLToPath } from "node:url";

import svelte from "eslint-plugin-svelte";
import oxlint from "eslint-plugin-oxlint";
import tseslint from "typescript-eslint";

export default tseslint.config(
	...tseslint.configs.strictTypeChecked,
	...svelte.configs.recommended,
	{
		name: "eslint/type-aware-rules",
		files: ["**/*.ts"],
		languageOptions: {
			parserOptions: {
				projectService: true,
			},
		},
	},
	...oxlint.buildFromOxlintConfigFile(fileURLToPath(new URL("../../.oxlintrc.json", import.meta.url))),
);
