# syntax=docker/dockerfile:1.28@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b
# Build from the repository root: docker build -f apps/label-studio/Dockerfile -t label-studio .
FROM node:26.12.1-bookworm-slim@sha256:88e480776c6149ff1d098cd304f44bf18057fb5d284a3329b78162d29821e28c AS base
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	&& npm install -g pnpm@12.16.1
WORKDIR /workspace

FROM base AS build
COPY . .
RUN CI=true pnpm install --frozen-lockfile --filter @petalnet/label-studio \
	&& pnpm --filter @petalnet/label-studio build

FROM base
ARG MONOREPO_SHA=unknown
LABEL org.opencontainers.image.source=https://github.com/PetalNet/monorepo
LABEL org.opencontainers.image.revision=$MONOREPO_SHA
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 LABEL_STUDIO_DATA_DIR=/app/data BODY_SIZE_LIMIT=8M
COPY --from=build /workspace/node_modules /workspace/node_modules
COPY --from=build /workspace/apps/label-studio/node_modules /workspace/apps/label-studio/node_modules
COPY --from=build /workspace/apps/label-studio/package.json /workspace/apps/label-studio/package.json
COPY --from=build /workspace/apps/label-studio/build /workspace/apps/label-studio/build
WORKDIR /workspace/apps/label-studio
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["node", "build"]
