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

# drizzle-kit is a devDependency, and that is CORRECT: no collegemap source file
# imports it, and `knip --strict` fails the build if it is declared as a runtime
# dependency. But the CONTAINER genuinely needs it -- docker-entrypoint.sh runs
# `drizzle-kit push` at boot, and drizzle.config.ts itself does
#   import { defineConfig } from "drizzle-kit"
# which resolves relative to /app. Without it the container does not merely fetch
# from the network, it fails to start:
#   Cannot find module 'drizzle-kit'  Require stack: /app/drizzle.config.ts
#
# So this is a deployment need rather than a source dependency, and it belongs in
# the image rather than in the manifest. The version is read back from the build
# stage instead of hardcoded, so it is always exactly what the workspace lockfile
# resolved and cannot drift from the catalog.
#
# `--config.strict-dep-builds=false` is needed because /out has no
# `onlyBuiltDependencies` allowlist (that lives in the workspace root, which is
# deliberately not copied here), so pnpm 11 hard-errors on the ignored build scripts
# of packages we do not use anyway -- prisma, better-sqlite3 and friends arrive only
# as unused optional peers of drizzle-orm. Nothing collegemap runs needs them built.
#
# The version is read from the manifest BY PATH rather than via require(): drizzle-kit's
# `exports` map does not expose "./package.json", so require('drizzle-kit/package.json')
# throws ERR_PACKAGE_PATH_NOT_EXPORTED. readFileSync follows pnpm's symlink into the store.
#
# The `test -x` is a build-time assertion, not decoration: if the install ever silently
# stops landing the binary, the build fails here rather than producing an image that dies
# on first boot. It only proves the binary ARRIVED -- the container boot test with
# --network none is what proves it actually runs.
RUN DK_VERSION="$(node -p "JSON.parse(require('fs').readFileSync('/repo/apps/collegemap/node_modules/drizzle-kit/package.json','utf8')).version")" \
 && echo "pinning drizzle-kit@${DK_VERSION} into the runtime tree" \
 && node apps/collegemap/docker/resolve-runtime-manifest.ts /out /repo/apps/collegemap/node_modules \
 && pnpm --dir /out add --config.strict-dep-builds=false "drizzle-kit@${DK_VERSION}" \
 && test -x /out/node_modules/.bin/drizzle-kit

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
