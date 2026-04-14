import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	build: {
		// Optimize chunk splitting for better caching and parallel loading
		rollupOptions: {
			output: {
				manualChunks: {
					// Separate vendor chunks for better caching
					'vendor-ui': ['sortablejs', 'qrcode'],
				}
			}
		},
		// Reduce chunk size warnings threshold
		chunkSizeWarningLimit: 600
	},
	// Enable compression for dev server
	server: {
		compress: true
	}
});
