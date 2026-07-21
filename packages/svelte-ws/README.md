# @petalnet/svelte-ws

WebSocket support for SvelteKit on Node, vendored from
[sowahq/svelte-ws](https://github.com/sowahq/svelte-ws) (MIT — see LICENSE_sowa).

Adaptations from upstream:

- Transport swapped from the `ws` package to **crossws** (`crossws/adapters/node`); handlers
  receive a `ConnectionSocket` seam plus the raw crossws `Peer`.
- The adapter's re-bundling step uses Vite's SSR build instead of raw rollup, so the package adds
  no bundler toolchain of its own.
- Per-route `_websocket.ts` modules, the Bun adapter, and the Cloudflare Durable Object path were
  dropped — this workspace serves one Node target with a single `handleWebsocket` server hook.

Usage: register `websocket()` from `@petalnet/svelte-ws/vite` in `vite.config.ts`, use the default
export as the SvelteKit adapter, and export `handleWebsocket` from `src/hooks.server.ts`.
