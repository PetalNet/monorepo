import process from "node:process";

import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

const e2e = process.env.CONSOLE_E2E === "1";

/** @type {import("@sveltejs/kit").Config} */
const config = {
	preprocess: vitePreprocess(),
	compilerOptions: { experimental: { async: true } },
	kit: {
		adapter: adapter(),
		experimental: {
			remoteFunctions: true,
		},
		csp: {
			mode: "auto",
			directives: {
				"base-uri": ["self"],
				"connect-src": ["self", "https:", "wss:"],
				"default-src": ["self"],
				"font-src": ["self"],
				"form-action": ["self"],
				"frame-ancestors": ["none"],
				"img-src": ["self", "data:"],
				"object-src": ["none"],
				"script-src": ["self", ...(e2e ? ["unsafe-inline"] : [])],
				"style-src": ["self", "unsafe-inline"],
				"worker-src": ["self", "blob:"],
			},
		},
	},
};

export default config;
