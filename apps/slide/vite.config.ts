import adapter from "@sveltejs/adapter-node";
import { sveltekit } from "@sveltejs/kit/vite";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			preprocess: vitePreprocess(),

			// Using adapter-node for production Docker deployment
			adapter: adapter({ out: "build", precompress: true, envPrefix: "" }),

			csrf: {
				trustedOrigins: ["*"] /* Disable CSRF origin check (behind Cloudflare Tunnel) */,
			},
		}),
	],
});
