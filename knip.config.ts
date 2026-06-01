import type { KnipConfig } from "knip";

// Note: we don't set `treatConfigHintsAsErrors` (flint does) — it flags
// production-only entries/ignores as "redundant in default mode", which fights
// the build.mts production entry and the drizzle-kit ignore below.
export default {
	ignoreExportsUsedInFile: { interface: true, type: true },
	workspaces: {
		".": {
			entry: ["*.config.{js,ts}"],
		},
		"apps/collegemap": {
			// drizzle.config.ts throws at import unless DATABASE_URL is set, so don't
			// let the drizzle plugin load it; drizzle-kit drives it + the db:* scripts.
			drizzle: false,
			ignore: ["drizzle.config.ts"],
			ignoreDependencies: ["drizzle-kit"],
		},
		"packages/tokens": {
			// Built via `node tools/build.mts` (a package.json script); tag it as a
			// production entry so the --production pass doesn't flag it as unused.
			entry: ["tools/build.mts!"],
		},
	},
} satisfies KnipConfig;
