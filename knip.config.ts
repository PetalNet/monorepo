import type { KnipConfig } from "knip";

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
			sveltekit: {
				config: ["vite.config.ts"],
			},
			paths: {
				"$app/env": ["node_modules/@sveltejs/kit/types/index.d.ts"],
				"$app/server": ["node_modules/@sveltejs/kit/types/index.d.ts"],
			},
			entry: [
				"effectdb.config.ts",
				"src/lib/server/db/tables.ts",
				"server/index.ts",
				"scripts/*.{ts,mjs}",
			],
		},
		"packages/better-auth-effect-qb-adapter": {
			entry: ["test/**/*.ts"],
		},
	},
} satisfies KnipConfig;
