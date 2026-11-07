import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["ci-manager/**/*.test.ts", "prisma-clients.test.ts"],
		testTimeout: 30_000,
	},
});
