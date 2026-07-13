import type { KnipConfig } from "knip";

export default {
	ignoreExportsUsedInFile: { interface: true, type: true },
	treatConfigHintsAsErrors: true,
	workspaces: {
		".": {
			entry: ["vite.config.ts"],
		},
		"apps/console": {
			entry: ["scripts/generate-contracts.mjs"],
		},
		"apps/collegemap": {
			drizzle: {
				config: [],
				entry: ["drizzle.config.ts"],
			},
		},
	},
} satisfies KnipConfig;
