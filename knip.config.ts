import type { KnipConfig } from "knip";

const config: KnipConfig = {
  workspaces: {
    ".": {
      entry: ["vite.config.ts"],
    },
    // Apps are leaf consumers with framework-managed entry points (SvelteKit
    // routes etc.); knip's dead-code analysis is noisy there. Run dependency
    // checks only, skip the unused-file/export pass.
    "apps/*": {
      entry: ["**/*.{js,ts,svelte}"],
      project: "**/*.{js,ts,svelte}",
      ignore: ["**"],
    },
    "packages/*": {
      entry: ["src/index.{js,ts}"],
      project: "src/**/*.{js,ts}",
    },
  },
};

export default config;
