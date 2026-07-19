import type { KnipConfig } from "knip";

export default {
	// An export used in its own module is not dead code; several (op capabilities, contract
	// schemas) are additionally imported by the test suite, which the production graph ignores.
	ignoreExportsUsedInFile: true,
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
			// Scripts are deploy/ops entrypoints (seed, bridge daemon, token mint, capability
			// install) — production surface, hence the `!` markers.
			entry: ["effectdb.config.ts!", "src/lib/server/db/tables.ts!", "scripts/*.{ts,mjs}!"],
		},
		"packages/better-auth-effect-qb-adapter": {
			entry: ["test/**/*.ts"],
		},
		"packages/svelte-ws": {
			// Adapt-time runtime template: copied into the app build by the adapter, not imported.
			// SERVER_HOOKS is a build-time placeholder the adapter rewrites to the compiled hooks
			// module — it is not a dependency.
			entry: ["files/websocket-runtime.js"],
			ignoreDependencies: ["SERVER_HOOKS"],
		},
	},
} satisfies KnipConfig;
