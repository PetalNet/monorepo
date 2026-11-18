# Build from the monorepo root:
# docker build -f apps/chaos/Dockerfile --build-arg MONOREPO_SHA="$SHA" -t "chaos:$SHA" .
FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS build

RUN npm install -g pnpm@12.21.0
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter=@petalnet/chaos... --ignore-scripts
WORKDIR /repo/apps/chaos
RUN pnpm exec svelte-kit sync && pnpm build

# adapter-node bundles every dependency, so the runtime image needs no node_modules.
FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94
ARG MONOREPO_SHA=unknown
LABEL org.opencontainers.image.source=https://github.com/PetalNet/monorepo
LABEL org.opencontainers.image.revision=$MONOREPO_SHA
WORKDIR /app
COPY --from=build /repo/apps/chaos/build ./build
RUN echo '{"type":"module"}' > package.json && mkdir data && chown node:node data
ENV NODE_ENV=production CHAOS_DATA_DIR=/app/data
USER node
EXPOSE 3000
CMD ["node", "build"]
