# Build from the MONOREPO ROOT as context:
#   docker build -f apps/collegemap/Dockerfile -t collegemap-map .
#
# collegemap declares zero `workspace:` dependencies, but every version it
# declares is a `catalog:` reference, so the root pnpm-workspace.yaml and
# pnpm-lock.yaml must be in the context for install to resolve anything.

# Stage 1: Build
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS build

# Pinned to the root package.json `packageManager` field, not @latest.
RUN corepack enable && corepack prepare pnpm@11.11.0 --activate

WORKDIR /repo

# Copy the whole workspace: `--frozen-lockfile` validates the lockfile against
# every importer, so a manifest-only COPY would have to enumerate all 22
# package.json files and would rot the moment one is added or removed.
COPY . .

# The filter narrows the install to collegemap and skips the other 21 workspace
# members. It does not exclude the workspace root, whose `prepare` script runs
# `effect-tsgo patch` -- so this install must stay non-`--prod`, otherwise the
# root's `@effect/tsgo` devDependency is missing and prepare dies with
# `effect-tsgo: not found`. Pruning to production happens at the deploy step.
RUN pnpm install --frozen-lockfile --filter=@petalnet/collegemap...

WORKDIR /repo/apps/collegemap
RUN DATABASE_URL=file:placeholder.db pnpm build

# Prune to a production-only tree at /out that is self-contained, so it can be
# copied to a different path in the runtime stage without the surrounding
# workspace layout coming with it.
WORKDIR /repo
RUN pnpm deploy --filter=@petalnet/collegemap --prod --legacy /out

# Stage 2: Runtime
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

WORKDIR /app

COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/collegemap/build ./build

COPY apps/collegemap/drizzle.config.ts ./
COPY apps/collegemap/src/lib/server/db/schema.ts ./src/lib/server/db/schema.ts
COPY apps/collegemap/docker-entrypoint.sh ./

RUN chmod +x docker-entrypoint.sh

ENV DATABASE_URL=file:/data/local.db
EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
