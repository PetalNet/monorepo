import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** Tasks — dead-simple local-first tracker. adapter-node so it deploys as a plain Node server (Docker on .14). */
export default {
  preprocess: vitePreprocess(),
  kit: { adapter: adapter() }
};
