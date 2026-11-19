# Agent guidance

## Build on the repo's own packages

Before adding a dependency or a new stack, look in `packages/` for what already does the job and use it.

For any JS/TS web or API surface (an HTTP server, web app, API endpoint, MCP server), build on `packages/effect-sveltekit` and `packages/effect-api`: Effect services and layers, typed errors, SvelteKit remote functions. Read both, plus `apps/grove`, which uses them, before starting. Do not add Express, Hono, Fastify or a bare `+server.ts`.

Other languages are fine where they are chosen for a reason (model inference, ML and data work, Rust, Flutter, hooks, CLIs). Say the reason in the PR.
