# syntax=docker/dockerfile:1.28@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b
FROM node:26.5.1-bookworm-slim@sha256:9e6f9357d371591e32ab6f2d8a26d63bdd0d17c29eee3f4f3e7e454d9634bf73 AS base
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/* && npm install -g pnpm@12.16.1
WORKDIR /workspace
FROM base AS build
COPY . .
RUN CI=true pnpm install --frozen-lockfile --filter @petalnet/tasks && pnpm --filter @petalnet/tasks build
FROM node:26.5.1-bookworm-slim@sha256:9e6f9357d371591e32ab6f2d8a26d63bdd0d17c29eee3f4f3e7e454d9634bf73
ARG MONOREPO_SHA=unknown
LABEL org.opencontainers.image.source=https://github.com/PetalNet/monorepo
LABEL org.opencontainers.image.revision=$MONOREPO_SHA
ENV NODE_ENV=production PORT=8896
COPY --from=build /workspace/node_modules /workspace/node_modules
COPY --from=build /workspace/apps/tasks/node_modules /workspace/apps/tasks/node_modules
COPY --from=build /workspace/apps/tasks/package.json /workspace/apps/tasks/package.json
COPY --from=build /workspace/apps/tasks/build /workspace/apps/tasks/build
COPY --from=build /workspace/apps/tasks/server.js /workspace/apps/tasks/server.js
COPY --from=build /workspace/apps/tasks/mcp /workspace/apps/tasks/mcp
COPY --from=build /workspace/apps/tasks/scripts/archive-events.mjs /workspace/apps/tasks/scripts/mint-agent-token.mjs /workspace/apps/tasks/scripts/
COPY --from=build /workspace/apps/tasks/src/lib/server /workspace/apps/tasks/src/lib/server
WORKDIR /workspace/apps/tasks
RUN mkdir -p /data
EXPOSE 8896
CMD ["node", "server.js"]
