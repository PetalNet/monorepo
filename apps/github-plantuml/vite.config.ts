import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite";

const manifest = {
	manifest_version: 3,
	name: "GitHub PlantUML",
	version: "0.0.1",
	description: "Render PlantUML files and diffs locally on GitHub.",
	permissions: ["storage"],
	host_permissions: ["https://github.com/*", "https://raw.githubusercontent.com/*"],
	optional_host_permissions: ["https://*/*", "http://*/*"],
	content_security_policy: {
		extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
	},
	background: { service_worker: "background.js", type: "module" },
	content_scripts: [
		{
			matches: ["https://github.com/*"],
			js: ["content.js"],
			css: ["content.css"],
			run_at: "document_idle",
		},
	],
	web_accessible_resources: [
		{
			resources: [
				"renderer.html",
				"frame.js",
				"plantuml/plantuml.js",
				"plantuml/viz-global.js",
				"plantuml/themes.js",
			],
			matches: ["https://github.com/*"],
		},
	],
	options_page: "options.html",
} as const;

function extensionAssets(): Plugin {
	const directory = import.meta.dirname;

	return {
		name: "extension-assets",
		// The content environment builds last, after every entry is in dist/chrome.
		applyToEnvironment: (environment) => environment.name === "content",
		async closeBundle() {
			const destination = path.join(directory, "dist/chrome");

			await mkdir(path.join(destination, "plantuml"), { recursive: true });

			await Promise.all([
				writeFile(path.join(destination, "manifest.json"), JSON.stringify(manifest, undefined, 2)),
				writeFile(
					path.join(destination, "renderer.html"),
					await readFile(path.join(directory, "renderer.html")),
				),
				cp(
					fileURLToPath(import.meta.resolve("@plantuml/core/plantuml.js")),
					path.join(destination, "plantuml/plantuml.js"),
				),
				cp(
					fileURLToPath(import.meta.resolve("@plantuml/core/viz-global.js")),
					path.join(destination, "plantuml/viz-global.js"),
				),
				cp(
					fileURLToPath(import.meta.resolve("@plantuml/core/themes.js")),
					path.join(destination, "plantuml/themes.js"),
				),
			]);

			const firefox = {
				...manifest,
				background: { scripts: ["background.js"], type: "module" },
				browser_specific_settings: { gecko: { id: "github-plantuml@petalnet.dev" } },
			};

			await rm(path.join(directory, "dist/firefox"), { recursive: true, force: true });
			await cp(destination, path.join(directory, "dist/firefox"), { recursive: true });

			await writeFile(
				path.join(directory, "dist/firefox/manifest.json"),
				JSON.stringify(firefox, undefined, 2),
			);
		},
	};
}

const output = {
	entryFileNames: "[name].js",
	assetFileNames: "[name][extname]",
	format: "es",
} as const;

export default defineConfig({
	root: import.meta.dirname,
	plugins: [extensionAssets()],
	builder: {},
	environments: {
		client: {
			build: {
				outDir: "dist/chrome",
				emptyOutDir: true,
				rolldownOptions: {
					input: {
						background: "src/background.ts",
						options: "options.html",
						frame: "src/frame.ts",
					},
					output,
				},
			},
		},
		// Chrome runs content scripts as classic scripts, so the content entry is built on
		// its own: anything it shares with the other entries is inlined, not imported.
		content: {
			consumer: "client",
			build: {
				outDir: "dist/chrome",
				emptyOutDir: false,
				rolldownOptions: { input: { content: "src/content.ts" }, output },
			},
		},
	},
});
