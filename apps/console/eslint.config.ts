import svelte from "eslint-plugin-svelte";
import tseslint from "typescript-eslint";

const typedFiles = ["**/*.{ts,svelte}"];

export default tseslint.config(
	...tseslint.configs.strictTypeChecked,
	...tseslint.configs.stylisticTypeChecked,
	...svelte.configs.recommended,
	{
		files: typedFiles,
		languageOptions: {
			parserOptions: {
				parser: tseslint.parser,
				projectService: true,
				extraFileExtensions: [".svelte"],
			},
		},
	},
);
