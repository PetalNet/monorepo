export default {
	useTabs: true,
	singleQuote: false,
	semi: true,
	sortImports: true,
	sortTailwindcss: true,
	jsdoc: true,
	svelte: true,
	// Package sorting remains owned by ESLint; vendored designs stay byte-faithful.
	ignorePatterns: ["**/package.json", "pnpm-lock.yaml", "apps/point/docs/design/**"],
	overrides: [
		{
			// Match drizzle-kit's JSON.stringify output for generated migration metadata.
			files: ["**/drizzle/meta/*.json"],
			options: { parser: "json-stringify", useTabs: false, tabWidth: 2 },
		},
	],
};
