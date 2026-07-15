import process from "node:process";

import type { KnipConfig } from "knip";

const strict = process.argv.includes("--strict");

export default {
	ignoreExportsUsedInFile: { interface: true, type: true },
	treatConfigHintsAsErrors: true,
	workspaces: {
		".": {
			entry: ["vite.config.ts"],
		},
		"apps/collegemap": {
			drizzle: {
				config: [],
				entry: ["drizzle.config.ts"],
			},
		},
		"apps/console": {
			entry: [
				"effectdb.config.ts",
				"src/hooks.{client,server}.ts",
				"src/instrumentation.server.ts",
				"src/routes/**/+{layout,layout.server,page,page.server,server}.{svelte,ts}",
				"src/routes/**/*.remote.ts",
			],
			ignore: ["src/lib/server/db/tables.ts", ...(strict ? ["scripts/generate-contracts.mjs"] : [])],
			ignoreDependencies: ["effect-qb", "import-in-the-middle"],
			ignoreUnresolved: ["^\\$app/(env|server)$"],
		},
	},
} satisfies KnipConfig;
