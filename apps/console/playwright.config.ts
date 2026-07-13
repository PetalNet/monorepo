import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: "./tests",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: "line",
	use: {
		baseURL: "http://127.0.0.1:43173",
		trace: "retain-on-failure",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: [
		{
			command: "node tests/contract-server.mjs",
			port: 43174,
			reuseExistingServer: false,
		},
		{
			command:
				"CONSOLE_E2E=1 PUBLIC_CONSOLE_DATA_MODE=live PUBLIC_CONSOLE_API_BASE=http://127.0.0.1:43173/api/v1 PUBLIC_GLITCHTIP_DSN=http://public@127.0.0.1:43173/1 vite dev --config tests/e2e-vite.ts --host 127.0.0.1 --port 43173",
			port: 43173,
			reuseExistingServer: false,
		},
	],
});
