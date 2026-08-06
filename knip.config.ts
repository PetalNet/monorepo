import type { KnipConfig } from "knip";

export default {
	ignore: [".agents/skills/impeccable/**"],
	// Virtual tsconfig plugin provided by the patched @effect/tsgo compiler.
	ignoreDependencies: ["@effect/language-service"],
	ignoreExportsUsedInFile: { type: true, interface: true },
	treatConfigHintsAsErrors: true,
	workspaces: {
		"apps/collegemap": {
			drizzle: {
				config: [],
				entry: ["drizzle.config.ts"],
			},
		},
		"apps/console": {
			ignoreDependencies: ["crossws!"],
			// Scripts are deploy/ops entrypoints (seed, bridge daemon, token mint, capability
			// install) — production surface, hence the `!` markers.
			entry: [
				"effectdb.config.ts!",
				"src/lib/server/db/tables.ts!",
				"src/env.ts!",
				"scripts/*.{ts,mjs}!",
				"src/**/*.test.ts",
				"test/**/*.ts",
			],
		},
		"apps/grove": {
			entry: ["effectdb.config.ts!", "src/env.ts!"],
		},
		"apps/storybook": {
			entry: [".storybook/*.ts!", "src/**/*.stories.ts!", "src/**/*.svelte!"],
		},
		"packages/better-auth-effect-qb-adapter": {
			entry: ["test/**/*.ts"],
		},
		"packages/svelte-ws": {
			// Adapt-time runtime template: copied into the app build by the adapter, not imported.
			// SERVER_HOOKS is a build-time placeholder the adapter rewrites to the compiled hooks
			// module — it is not a dependency.
			entry: ["files/websocket-runtime.ts"],
			ignoreDependencies: ["SERVER_HOOKS"],
		},
	},
} satisfies KnipConfig;
