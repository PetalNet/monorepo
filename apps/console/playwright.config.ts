import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: "./tests",
	testMatch: "**/*.e2e.ts",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: "line",
	use: {
		baseURL: "http://127.0.0.1:43173",
		trace: "retain-on-failure",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
