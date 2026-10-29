# syntax=docker/dockerfile:1.28@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b
# Build from the repository root: docker build -f apps/petalboard/Dockerfile -t petalboard .
FROM node:26.5.1-bookworm-slim AS base
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates openssl \
	&& rm -rf /var/lib/apt/lists/* \
	&& npm install -g pnpm@12.11.2
WORKDIR /workspace

FROM base AS build
COPY . .
RUN CI=true pnpm install --frozen-lockfile --filter @petalnet/petalboard \
	&& pnpm --filter @petalnet/petalboard build

FROM base
ARG MONOREPO_SHA=unknown
LABEL org.opencontainers.image.source=https://github.com/PetalNet/monorepo
LABEL org.opencontainers.image.revision=$MONOREPO_SHA
ENV NODE_ENV=production PORT=4173 DATABASE_URL=file:/app/data/dev.db
COPY --from=build /workspace/node_modules /workspace/node_modules
COPY --from=build /workspace/apps/petalboard/node_modules /workspace/apps/petalboard/node_modules
COPY --from=build /workspace/apps/petalboard/package.json /workspace/apps/petalboard/package.json
COPY --from=build /workspace/apps/petalboard/prisma /workspace/apps/petalboard/prisma
COPY --from=build /workspace/apps/petalboard/build /workspace/apps/petalboard/build
# The bundled client loads its query engine from the generated directory.
COPY --from=build /workspace/apps/petalboard/src/lib/server/generated /workspace/apps/petalboard/src/lib/server/generated
WORKDIR /workspace/apps/petalboard
RUN mkdir -p /app/data
EXPOSE 4173
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && exec node build"]
