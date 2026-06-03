import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  // Consult https://svelte.dev/docs/kit/integrations
  // for more information about preprocessors
  preprocess: vitePreprocess(),

  kit: {
    // Using adapter-node for production Docker deployment
    adapter: adapter({
      out: "build",
      precompress: true,
      envPrefix: "",
    }),
    csrf: {
      checkOrigin: false, // Disable CSRF origin check (behind Cloudflare Tunnel)
    },
    // Trust proxy headers (required for Cloudflare Tunnel)
    env: {
      publicPrefix: "PUBLIC_",
    },
  },
};

export default config;
