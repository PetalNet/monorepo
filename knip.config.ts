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
		...(strict
			? {
					"apps/console": {
						ignore: ["scripts/generate-contracts.mjs"],
					},
				}
			: {}),
		"apps/collegemap": {
			drizzle: {
				config: [],
				entry: ["drizzle.config.ts"],
			},
		},
	},
} satisfies KnipConfig;
