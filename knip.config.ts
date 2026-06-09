import type { KnipConfig } from "knip";

export default {
	ignoreExportsUsedInFile: { interface: true, type: true },
	treatConfigHintsAsErrors: true,
	workspaces: {
		".": {
			entry: ["vite.config.ts"],
		},
		"packages/tokens": {
			project: ["!tools/build.mts!"],
		},
		// Tests run via `vp test` (Vitest under the hood), but Vite+ bundles its
		// own test runtime so there's no `vitest` dependency for knip to detect —
		// declare the test files as entry points explicitly so they aren't flagged
		// as unused.
		"packages/search": {
			// Test files plus the runnable federation demo (an intentional executable,
			// not dead code) are entry points; the library surface is `src/index.ts`.
			entry: ["src/**/*.test.ts", "src/example.ts"],
			// `vitest` is not a declared dependency: `vp test` provides the Vitest
			// runtime (re-exported from @voidzero-dev/vite-plus-test), so the import
			// resolves at test time without a package.json entry. Tell knip it's
			// supplied externally rather than missing.
			ignoreDependencies: ["vitest"],
		},
		"apps/collegemap": {
			drizzle: {
				config: [],
				entry: ["drizzle.config.ts"],
			},
		},
	},
} satisfies KnipConfig;
