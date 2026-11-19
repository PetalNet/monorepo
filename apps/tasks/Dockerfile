# syntax=docker/dockerfile:1.29@sha256:572cebbc2b15e6f84c077742952674889cb63cd5e9b80abdffcbe587b6f19183
FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS base
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/* && npm install -g pnpm@12.16.1
WORKDIR /workspace
FROM base AS build
COPY . .
RUN CI=true pnpm install --frozen-lockfile --filter @petalnet/tasks && pnpm --filter @petalnet/tasks build
# A filtered install still links the workspace root's dev tooling (~900 MB). Ship only the
# production dependency tree of the tasks package.
RUN CI=true pnpm --filter @petalnet/tasks deploy --prod /prod
FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1
ARG MONOREPO_SHA=unknown
LABEL org.opencontainers.image.source=https://github.com/PetalNet/monorepo
LABEL org.opencontainers.image.revision=$MONOREPO_SHA
ENV NODE_ENV=production PORT=8896
COPY --from=build /prod/node_modules /workspace/apps/tasks/node_modules
COPY --from=build /workspace/apps/tasks/package.json /workspace/apps/tasks/package.json
COPY --from=build /workspace/apps/tasks/build /workspace/apps/tasks/build
COPY --from=build /workspace/apps/tasks/server.js /workspace/apps/tasks/server.js
COPY --from=build /workspace/apps/tasks/mcp /workspace/apps/tasks/mcp
COPY --from=build /workspace/apps/tasks/scripts/archive-events.mjs /workspace/apps/tasks/scripts/mint-agent-token.mjs /workspace/apps/tasks/scripts/tasks-keeper.mjs /workspace/apps/tasks/scripts/sync-makkit-docs.mjs /workspace/apps/tasks/scripts/
COPY --from=build /workspace/apps/tasks/src/lib/server /workspace/apps/tasks/src/lib/server
WORKDIR /workspace/apps/tasks
RUN mkdir -p /data
EXPOSE 8896
CMD ["node", "server.js"]
