import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
	testDir: "test/browser",
	fullyParallel: false,
	workers: 1,
	timeout: 45000,
	outputDir: ".cache/browser-results",
	reporter: [["list"], ["json", { outputFile: ".cache/browser-results/results.json" }]],
	use: {
		extraHTTPHeaders: { "X-Forwarded-Proto": "http" },
		baseURL: "http://127.0.0.1:18806",
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	projects: [
		{
			name: "android-chromium",
			use: {
				...devices["Pixel 7"],
				browserName: "chromium",
				launchOptions: {
					args: [
						"--use-fake-device-for-media-stream",
						"--use-fake-ui-for-media-stream",
						"--autoplay-policy=no-user-gesture-required",
					],
				},
			},
		},
		{
			name: "desktop-chromium",
			use: {
				...devices["Desktop Chrome"],
				launchOptions: {
					args: [
						"--use-fake-device-for-media-stream",
						"--use-fake-ui-for-media-stream",
						"--autoplay-policy=no-user-gesture-required",
					],
				},
			},
		},
		{ name: "iphone-webkit", use: { ...devices["iPhone 13"], browserName: "webkit" } },
		{
			name: "desktop-firefox",
			use: {
				...devices["Desktop Firefox"],
				browserName: "firefox",
				launchOptions: {
					firefoxUserPrefs: {
						"media.navigator.streams.fake": true,
						"media.navigator.permission.disabled": true,
						"media.autoplay.default": 0,
						"media.autoplay.blocking_policy": 0,
						"media.autoplay.block-webaudio": false,
					},
				},
			},
		},
	],
	webServer: {
		command: "sh test/start-server.sh",
		url: "http://127.0.0.1:18806",
		reuseExistingServer: false,
		timeout: 30000,
		env: {
			PROTOCOL_HEADER: "X-Forwarded-Proto",
			PORT: "18806",
			HOST: "127.0.0.1",
			ORIGIN: "http://127.0.0.1:18806",
			BOOTH_SECRET: "browser-test-secret-isolated-not-for-production-1234567890",
			BOOTH_DATA: ".cache/browser-recordings",
		},
	},
});
