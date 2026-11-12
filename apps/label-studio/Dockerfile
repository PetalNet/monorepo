# syntax=docker/dockerfile:1.28@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b
# Build from the repository root: docker build -f apps/label-studio/Dockerfile -t label-studio .
FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS build
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	&& npm install -g pnpm@12.16.1
WORKDIR /workspace
COPY . .
RUN CI=true pnpm install --frozen-lockfile --filter @petalnet/label-studio \
	&& pnpm --filter @petalnet/label-studio build
# A filtered install still links the workspace root's dev tooling. Ship only the production
# dependency tree of label-studio, which adapter-node leaves external.
RUN CI=true pnpm --filter @petalnet/label-studio deploy --prod /prod

FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68
ARG MONOREPO_SHA=unknown
LABEL org.opencontainers.image.source=https://github.com/PetalNet/monorepo
LABEL org.opencontainers.image.revision=$MONOREPO_SHA
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 LABEL_STUDIO_DATA_DIR=/app/data BODY_SIZE_LIMIT=8M
COPY --from=build /prod/node_modules /workspace/apps/label-studio/node_modules
COPY --from=build /workspace/apps/label-studio/package.json /workspace/apps/label-studio/package.json
COPY --from=build /workspace/apps/label-studio/build /workspace/apps/label-studio/build
WORKDIR /workspace/apps/label-studio
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["node", "build"]
