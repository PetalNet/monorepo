import type { KnipConfig } from "knip";

// Knip passes the parsed CLI flags to a config function (KnipConfig's function form).
export default (({ strict }) => ({
	ignore: [".agents/skills/impeccable/**", "apps/tasks/static/vendor/**"],
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
	],
	ignoreExportsUsedInFile: { type: true, interface: true },
	treatConfigHintsAsErrors: true,
	workspaces: {
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
			ignoreDependencies: [
				// Only the gitignored generated Prisma client imports @prisma/client/runtime.
				"@prisma/client",
				// The image's CMD runs `prisma migrate deploy`, which strict Knip cannot see. The
				// non-strict run still counts the package scripts that use it.
				"prisma!",
			],
		},
		"apps/tasks": {
			// Cron, MCP, and production server entrypoints run directly rather than being imported.
			entry: ["mcp/*.mjs!", "scripts/*.mjs!"],
			ignore: ["static/vendor/**"],
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
			ignoreBinaries: ["prisma!"],
		},
		"apps/storybook": {
			entry: [".storybook/*.ts!", "src/**/*.stories.ts!", "src/**/*.svelte!"],
		},
		"packages/better-auth-effect-qb-adapter": {
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
