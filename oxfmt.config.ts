export default {
	useTabs: true,
	singleQuote: false,
	semi: true,
	sortImports: true,
	sortPackageJson: true,
	sortTailwindcss: true,
	jsdoc: true,
	svelte: true,
	ignorePatterns: [
		// Vendored designs stay byte-faithful.
		"apps/point/docs/design/**",
	],
	overrides: [
		{
			// Match drizzle-kit's JSON.stringify output for generated migration metadata.
			files: ["**/drizzle/meta/*.json"],
			options: { parser: "json-stringify", useTabs: false, tabWidth: 2 },
		},
	],
};
