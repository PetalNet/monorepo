import type { KnipConfig } from "knip";

export default {
	ignoreExportsUsedInFile: { interface: true, type: true },
	treatConfigHintsAsErrors: true,
	workspaces: {
		".": {
			entry: ["*.config.{js,ts}"],
		},
		"packages/tokens": {
			// tools/build.mts is a build-time script (style-dictionary), not part of
			// production — keep it out of the production project so --strict doesn't
			// flag it (or its build-only imports) as unused.
			project: ["src/**/*.{ts,mts}!", "!tools/build.mts!"],
		},
	},
} satisfies KnipConfig;
