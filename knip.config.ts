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
			entry: ["tests/contract-server.mjs", "tests/e2e-vite.ts"],
			...(strict ? { ignore: ["scripts/generate-contracts.mjs"] } : {}),
			ignoreUnresolved: ["^/src/lib/api/client\\.ts$"],
		},
	},
} satisfies KnipConfig;
