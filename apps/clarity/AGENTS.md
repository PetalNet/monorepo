# Clarity

- Use the root pnpm workspace. Run `pnpm --filter @petalnet/clarity check` and `pnpm --filter @petalnet/clarity test` alongside the Vite build.
- Preserve the same-origin proxy contract. The reverse proxy serves `/search`, `/autocompleter`, `/config`, `/image_proxy`, `/favicon`, and `/answer`. SvelteKit serves the frontend, `/fx`, `/engines/*`, and `/egress`.
- Keep Numbat's JS and WASM in `static/numbat/pkg`. The browser imports them at runtime.
- Keep `src/lib/clarity/clarity.css` last in `src/routes/+layout.svelte`. The daisyUI import excludes `button`, `menu`, `kbd`, and `status` because Clarity uses those class names.
- Verify the adapter-node build behind a preview proxy with real Chromium before deploying. Submit a query in the search field and check that results render from SearXNG.
