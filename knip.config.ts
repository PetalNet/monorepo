import type { KnipConfig } from "knip";

// Knip passes the parsed CLI flags to a config function (KnipConfig's function form).
export default (({ strict }) => ({
	ignore: [".agents/skills/impeccable/**"],
	rules: { cycles: "error" },
	// Apps keep bundled packages in devDependencies, so strict mode, which counts only
	// dependencies, would report every bundled import as unlisted. Packages keep the check.
	ignoreIssues: strict ? { "apps/**": ["unlisted"] } : {},
	// Strict Knip only resolves production dependencies, including script binaries.
	ignoreBinaries: ["eslint!", "vite!", "vitest!", "storybook!"],
	ignoreDependencies: [
		// pnpm links agent skills; they are not imported by application code.
		"antislop-ai",
		// Virtual tsconfig plugin provided by the patched @effect/tsgo compiler.
		"@effect/language-service",
		// Selects the tsrs build that effect-tsgo runs; no script names its binary.
		"tsrs",
	],
	ignoreExportsUsedInFile: { type: true, interface: true },
	treatConfigHintsAsErrors: true,
	workspaces: {
		"apps/turbo-cache": {
			entry: ["src/main.ts!", "test/**/*.ts"],
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
			entry: ["docker/*.ts!", "scripts/*.ts!", "src/env.ts!"],
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
				"src/env.ts!",
				"test/**/*.ts",
				"migrations/*.ts!",
			],
		},
		"apps/label-studio": {
			// Loopback listener shared by the server tests; nothing in production imports it.
			entry: ["src/lib/server/testing.ts"],
			// The TLS tests mint throwaway certificates with the system openssl, not an npm package.
			ignoreBinaries: ["openssl"],
		},
		"apps/numbat-sheet": {
			// build:wasm needs the Rust wasm-bindgen CLI, which is not an npm package.
			ignoreBinaries: ["wasm-bindgen"],
		},
		"apps/petalboard": {
			// SvelteKit loads src/env.ts by convention.
			entry: ["src/env.ts!"],
			// Read by the Prisma CLI through prisma.config.ts, which Knip does not follow.
			ignore: ["prisma/schema.prisma"],
			ignoreDependencies: [
				// Only the gitignored generated Prisma client imports @prisma/client/runtime.
				"@prisma/client",
				// The image's CMD runs `prisma migrate deploy`, which strict Knip cannot see. The
				// non-strict run still counts the package scripts that use it.
				"prisma!",
			],
		},
		"apps/tasks": {
			// Cron and production server entrypoints run directly rather than being imported.
			entry: ["scripts/*.mjs!"],

			ignoreDependencies: [
				// CSS @import directives load these fonts, which Knip does not analyze.
				"@fontsource-variable/geist",
				"@fontsource-variable/geist-mono",
				// Only @sentry/sveltekit imports these. They are listed so adapter-node keeps them
				// external, because bundled into the ESM server their require hook breaks require.
				"@sentry/core",
				"@sentry/node",
			],
		},
		"apps/slide": {
			// SvelteKit loads src/env.ts by convention.
			entry: ["src/env.ts!"],
			// Read by the Prisma CLI through prisma.config.ts, which Knip does not follow.
			ignore: ["prisma/schema.prisma"],
			// Only the gitignored generated Prisma client imports @prisma/client/runtime.
			ignoreDependencies: ["@prisma/client"],
			ignoreBinaries: ["prisma!"],
		},
		"apps/storybook": {
			entry: [".storybook/*.ts!", "src/**/*.stories.ts!", "src/**/*.svelte!"],
		},
		"apps/janet-matrix-comms": {
			// Each tool is a command line entry run by path under Node type stripping; archive.ts is imported by both.
			entry: ["src/{matrix-search,janet-matrix-comms-ingest}.ts!"],
		},
		"packages/better-auth-effect-qb-adapter": {
			entry: ["test/**/*.ts"],
		},
		"packages/harness-hooks": {
			// Each guard is a hook process Claude Code runs by path; the tests import its verdict.
			// Helpers are exported for the tests, which production-mode Knip does not read.
			ignoreIssues: { "src/**": ["exports"] },
			entry: [
				"src/*-guard.ts!",
				"src/matrix-reply-reminder.ts!",
				"src/matrix-reply-threading.ts!",
				"src/main-thread-budget.ts!",
				"src/main-thread-budget-run.ts!",
				"src/main-thread-budget-notify.ts!",
				"src/wake-filter.ts!",
				"src/sessionstart-objectives.ts!",
				"src/objectives-prune.ts!",
				"src/janet-voice.ts!",
				"src/promise.ts!",
				"src/quota.ts!",
			],
		},
		"packages/router": {
			// The tests import the bin's helpers, which production-mode Knip does not read.
			ignoreIssues: { "src/**": ["exports"] },
		},
		"packages/vault-engine": {
			entry: ["test/**/*.ts"],
		},
		"packages/vault-cite": {
			// The backfill ops scripts are production entrypoints an operator runs by hand, not imported.
			entry: ["test/**/*.ts", "scripts/*.ts!"],
			// gitleaks is an optional external scanner (not an npm package); episodes falls back
			// to the built-in rules when it is not on PATH.
			ignoreBinaries: ["gitleaks"],
		},
		"packages/effect-api": {
			// Strict Knip excludes the provider subpath's optional peer supplied by consumers.
			ignoreDependencies: ["@better-auth/mcp!"],
		},
	},
})) satisfies KnipConfig;
