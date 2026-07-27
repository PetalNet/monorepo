import type { KnipConfig } from "knip";

export default {
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
			// Knip's SvelteKit plugin reads the SK3 config out of `vite.config.ts`, but it only
			// does so when it statically sees `sveltekit` imported from `@sveltejs/kit/vite`
			// (knip/src/plugins/sveltekit/resolveFromAST.ts). This app configures Kit through
			// `svelte-plugin-composer`'s `kit()` wrapper instead, so that check never matches and
			// the plugin contributes nothing. Until knip can see through the wrapper, restate the
			// two things it would otherwise give us: the route/hook production entries and the
			// `$lib` alias. Grove uses the bare `sveltekit()` call and needs none of this.
			paths: {
				$lib: ["src/lib"],
				"$lib/*": ["src/lib/*"],
			},
			ignoreUnresolved: ["\\$app/.+"],
			entry: [
				// Stand-ins for the SvelteKit plugin's production entries (see note above).
				"src/routes/**/+{page,server,page.server,error,layout,layout.server}{,@*}.{js,ts,svelte}!",
				"src/hooks.{server,client}.{js,ts}!",
				"src/instrumentation.server.{js,ts}!",
				// Scripts are deploy/ops entrypoints (seed, bridge daemon, token mint, capability
				// install) — production surface, hence the `!` markers.
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
