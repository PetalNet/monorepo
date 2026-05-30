import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    printWidth: 80,
    // Why: package.json formatting + key-sorting is owned by
    // eslint-plugin-package-json; let oxfmt skip it so the two don't fight.
    ignorePatterns: ["**/package.json", "pnpm-lock.yaml"],
  },
});
