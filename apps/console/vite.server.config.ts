import { defineConfig } from "vite";

export default defineConfig({
	build: {
		ssr: "server/index.ts",
		outDir: "build-server",
		emptyOutDir: true,
		rollupOptions: { external: ["../build/handler.js"] },
	},
});
