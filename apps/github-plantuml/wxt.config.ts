import { fileURLToPath } from "node:url";

import { defineConfig } from "wxt";

// Copied verbatim: the renderer page loads the engine at runtime instead of bundling it.
const engine = {
	"plantuml/plantuml.js": import.meta.resolve("@plantuml/core/plantuml.js"),
	"plantuml/viz-global.js": import.meta.resolve("@plantuml/core/viz-global.js"),
	"plantuml/themes.js": import.meta.resolve("@plantuml/core/themes.js"),
};

export default defineConfig({
	outDir: "dist",
	imports: false,
	manifestVersion: 3,
	manifest: ({ browser }) => ({
		name: "GitHub PlantUML",
		description: "Render PlantUML files and diffs locally on GitHub.",
		permissions: ["storage"],
		host_permissions: ["https://github.com/*", "https://raw.githubusercontent.com/*"],
		optional_host_permissions: ["https://*/*", "http://*/*"],
		content_security_policy: {
			extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
		},
		web_accessible_resources: [
			{
				resources: ["renderer.html", ...Object.keys(engine)],
				matches: ["https://github.com/*"],
			},
		],
		...(browser === "firefox" && {
			browser_specific_settings: {
				gecko: {
					id: "github-plantuml@petalnet.dev",
					data_collection_permissions: { required: ["none"] },
				},
			},
		}),
	}),
	hooks: {
		"build:publicAssets": (_wxt, files) => {
			files.push(
				...Object.entries(engine).map(([relativeDest, url]) => ({
					absoluteSrc: fileURLToPath(url),
					relativeDest,
				})),
			);
		},
	},
});
