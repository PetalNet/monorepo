import type { KnipConfig } from "knip";

export default {
	ignore: [".agents/skills/impeccable/**"],
	// Virtual tsconfig plugin provided by the patched @effect/tsgo compiler.
	ignoreDependencies: ["@effect/language-service"],
	ignoreExportsUsedInFile: { type: true, interface: true },
	treatConfigHintsAsErrors: true,
	workspaces: {
		".": {
			// Repository-only operations are invoked by agents and build scripts, not imported.
			// The enrollment client is development-only; the boundary verifier runs in production builds.
			entry: ["tools/enroll-grove-dev-agent.mjs", "tools/verify-grove-production-boundary.mjs!"],
		},
		"apps/collegemap": {
			// Build-time deploy script run by the Dockerfile, and the ops script an operator runs
			// against the deployed database to load institutional breaks. Neither is imported by
			// anything: they are how the app gets built and how its data gets in. Same shape as
			// apps/console scripts/* below: production surface, hence the `!` markers.
			entry: ["docker/*.ts!", "scripts/*.ts!"],
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
			// Local OIDC is an orb operation entrypoint, not imported by Grove.
			entry: ["dev-oidc.mjs", "effectdb.config.ts!", "src/env.ts!", "test/**/*.ts"],
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
