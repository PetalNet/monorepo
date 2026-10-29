import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

export default defineConfig({
  plugins: [sveltekit(), basicSsl()],
  server: {
    host: "0.0.0.0", // Bind to all interfaces to allow IP address access
    port: 5173,
  },
});
