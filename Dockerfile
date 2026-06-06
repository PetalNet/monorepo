# syntax=docker/dockerfile:1.7
# Multi-stage build for any app in the monorepo. Select with --build-arg APP=@petalnet/<name>.
# Caching strategy: `pnpm fetch` keys the dependency layer on pnpm-lock.yaml ALONE, so
# source changes never bust it; the store is a BuildKit cache mount shared across all apps.
# (node 26 dropped corepack, so pnpm is installed explicitly. The only Docker-ism is the
#  cache mount — a nix derivation would express the same fetch/install/build/deploy steps.)

FROM node:26-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
ENV PNPM_STORE_DIR=/pnpm/store
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g pnpm@11.5.0
WORKDIR /repo

# ── fetch: cache deps keyed on the lockfile (+ workspace manifest & patches) ──
# pnpm fetch resolves patchedDependencies, so the workspace manifest and the
# patch files must be present. These change rarely, so the cache key stays stable.
FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch

# ── build: offline install from store, build one app, produce a pruned deploy dir ──
FROM fetch AS build
ARG APP
ARG APP_DIR
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install -r --offline --frozen-lockfile
# SvelteKit's postbuild analyse imports server modules that read env (e.g. db.js),
# so a placeholder DATABASE_URL must exist at build time. The real one is injected
# at runtime via the container env. SQLite-file form works for both slide & collegemap.
RUN DATABASE_URL=file:/tmp/build-placeholder.db pnpm --filter "$APP" run build
# --legacy: pnpm v10+ otherwise refuses to deploy workspaces without
# inject-workspace-packages; these leaf apps have no injected workspace deps.
RUN pnpm --filter "$APP" --prod --legacy deploy /app
# pnpm deploy honours .gitignore, which excludes the adapter-node `build/` output,
# so fold it into the deploy dir explicitly (the runtime entrypoint is `node build`).
RUN cp -r "/repo/${APP_DIR}/build" /app/build

# ── runtime: just the pruned app + its prod node_modules ──
FROM base AS runtime
ARG APP
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3000
CMD ["node", "build"]
