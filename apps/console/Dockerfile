# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89
# Unified Lab Console image — the single full-stack SvelteKit app (apps/console).
#
# One `node build/index.js` process serves the UI, the versioned /api/v1 REST
# surface, the in-process MCP endpoint, and the crossws WebSocket bus. See
# docs/adr/UNIFIED-SVELTEKIT-CONSOLE.md ("There is no second server process").
#
# Pattern: mirrors the folded-away apps/console-api/Dockerfile and the
# cd/console-dockerize-demo apps/console/Dockerfile (Node 26 bookworm-slim,
# monorepo-aware pnpm workspace install, filtered build, pruned
# `pnpm deploy --prod --legacy`, non-root uid 10001). Build context is the repo
# root (`.`), matching console-release.yml.

FROM node:26-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

# node:26 dropped corepack, so pin pnpm explicitly (matches root packageManager).
RUN npm install --global pnpm@11.11.0

# Copy the whole tree — .dockerignore keeps node_modules/build/.svelte-kit/.env
# out — so the workspace filter resolves every workspace:* dep the console now
# pulls in (svelte-ws, console-bus-rpc, better-auth-effect-qb-adapter, types)
# without hand-enumerating each package manifest.
COPY . .
RUN pnpm install --frozen-lockfile --filter @petalnet/console...

# Build the dependency graph in topological order: the workspace packages that
# have a `build` (types/svelte-ws/console-bus-rpc → tsc) emit first, then the
# console vite build. SvelteKit's postbuild analyse imports server modules that
# read env, so a placeholder DATABASE_URL must exist at build time; the real one
# is injected at runtime.
RUN DATABASE_URL=postgresql://placeholder@localhost:5432/placeholder \
      pnpm --filter @petalnet/console... run build

# Prune to a self-contained runtime dir. --legacy: pnpm v10+ otherwise refuses to
# deploy workspaces without inject-workspace-packages. pnpm deploy honours
# .gitignore (which excludes build/), so fold the adapter-node output back in,
# plus the assets the migrate entrypoint needs.
RUN pnpm --filter @petalnet/console deploy --prod --legacy /opt/console \
    && cp -R apps/console/build /opt/console/build \
    && cp -R apps/console/migrations /opt/console/migrations \
    && cp apps/console/effectdb.config.ts /opt/console/effectdb.config.ts

FROM node:26-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS runtime

ENV NODE_ENV=production
# adapter-node listen socket (docs/adr: `node build/index.js`).
ENV HOST=0.0.0.0
ENV PORT=3000
WORKDIR /app

RUN groupadd --system --gid 10001 console \
    && useradd --system --uid 10001 --gid console --home-dir /app console
COPY --from=build --chown=console:console /opt/console/ ./
COPY --from=build --chown=console:console /workspace/apps/console/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER console
EXPOSE 3000

# Liveness: the unified server is accepting TCP on $PORT. (Swap to an HTTP probe
# of /api/v1/health once confirmed that route is unauthenticated — see PR NOTE.)
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=5 \
  CMD node -e "require('node:net').connect(Number(process.env.PORT||3000),'127.0.0.1').on('connect',function(){process.exit(0)}).on('error',function(){process.exit(1)})"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
