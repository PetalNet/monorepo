# Agent guidance

## Build on the repo's own packages

Before adding a dependency or a new stack, look in `packages/` for what already does the job and use it.

For any new JS/TS web or API surface (an HTTP server, web app, API endpoint, MCP server), build on `packages/effect-sveltekit` and `packages/effect-api`: Effect services and layers, typed errors, REST, OpenAPI and MCP from one schema. Read both, plus `apps/grove`, which uses them, before starting. Do not add Express, Hono or Fastify, or hand-rolled `+server.ts` handlers. Existing routes stay as they are until someone is migrating that app.

Other languages are fine where they are chosen for a reason (model inference, ML and data work, Rust, Flutter, hooks, CLIs). Say the reason in the PR.
