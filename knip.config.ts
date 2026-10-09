import type { KnipConfig } from "knip";

export default {
	ignore: [".agents/skills/impeccable/**"],
	rules: { cycles: "error" },
	// Strict Knip only resolves production dependencies, including script binaries.
	ignoreBinaries: ["eslint!", "vite!", "vitest!", "storybook!"],
	ignoreDependencies: [
		// Virtual tsconfig plugin provided by the patched @effect/tsgo compiler.
		"@effect/language-service",
	],
	ignoreExportsUsedInFile: { type: true, interface: true },
	treatConfigHintsAsErrors: true,
	workspaces: {
		"apps/turbo-cache": {
			entry: ["src/main.ts!", "test/cache-process.ts"],
		},
		tools: {
			// Repository-only operations are invoked by agents and build scripts, not imported.
			// The enrollment client is development-only; build scripts own the production verifier.
			entry: ["enroll-grove-dev-agent.ts"],
			project: ["**/*.ts"],
		},
		"apps/collegemap": {
			// Build-time deploy script run by the Dockerfile, and the ops script an operator runs
			// against the deployed database to load institutional breaks. Neither is imported by
			// anything: they are production entrypoints, hence the `!` markers.
			entry: ["docker/*.ts!", "scripts/*.ts!"],
			drizzle: {
				config: [],
				entry: ["drizzle.config.ts"],
			},
		},
		"apps/grove": {
			// Local OIDC and the dynamically installed browser collector are dev entrypoints.
			// Their exports are intentionally absent from production's entry graph.
			ignoreIssues: { "src/lib/dev/**": ["exports"] },
			entry: [
				"dev-oidc.ts",
				"src/lib/dev/browser-logs.ts",
				"effectdb.config.ts!",
				// effect-db discovers these exported tables from its source glob.
				"src/lib/server/db/tables.ts!",
				"src/env.ts!",
				"test/**/*.ts",
			],
		},
		"apps/slide": {
			ignoreBinaries: ["prisma!"],
		},
		"apps/storybook": {
			entry: [".storybook/*.ts!", "src/**/*.stories.ts!", "src/**/*.svelte!"],
		},
		"packages/better-auth-effect-qb-adapter": {
			entry: ["test/**/*.ts"],
		},
	},
} satisfies KnipConfig;
