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
			ignore: [
				"src/app.css",
				"src/lib/auth-client.ts",
				"src/lib/server/auth-gate-policy.ts",
				"src/lib/server/auth/bootstrap.ts",
				"src/lib/server/auth/index.ts",
				"src/lib/server/console/service.ts",
				"src/lib/server/db/client.ts",
				"src/lib/server/db/migrate.ts",
				"src/lib/server/db/tables.ts",
				"src/lib/server/runtime/layer.ts",
				...(strict ? ["scripts/generate-contracts.mjs"] : []),
			],
			ignoreDependencies: [
				"@effect/sql-pg",
				"@lucide/svelte",
				"@opentelemetry/api",
				"@opentelemetry/auto-instrumentations-node",
				"@opentelemetry/exporter-trace-otlp-proto",
				"@opentelemetry/sdk-node",
				"@petalnet/better-auth-effect-qb-adapter",
				"@sentry/sveltekit",
				"better-auth",
				"daisyui",
				"effect",
				"effect-db",
				"effect-qb",
				"fontless",
				"import-in-the-middle",
				"svelte",
				"svelte-effect-runtime",
			],
			ignoreUnresolved: ["^\\$app/(env|server)$"],
		},
		"apps/console-api": {
			ignoreDependencies: ["@petalnet/types"],
		},
		"packages/better-auth-effect-qb-adapter": {
			entry: ["test/**/*.ts"],
		},
	},
} satisfies KnipConfig;
