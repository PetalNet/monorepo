import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Run the upstream conformance harness against Grove's actual minimal runtime,
// without importing Better Auth's unused built-in adapters or migration engine.
export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^better-auth$/,
				replacement: fileURLToPath(import.meta.resolve("better-auth/minimal")),
			},
			{
				find: /^better-auth\/db$/,
				replacement: fileURLToPath(import.meta.resolve("@better-auth/core/db")),
			},
		],
	},
	test: {
		server: { deps: { inline: ["@better-auth/test-utils"] } },
	},
});
