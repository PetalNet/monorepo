# syntax=docker/dockerfile:1.28@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b
# Build from the repository root: docker build -f apps/petalboard/Dockerfile -t petalboard .
FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS base
# Prisma's engines link against OpenSSL.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates openssl \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /workspace

FROM base AS build
RUN npm install -g pnpm@12.11.2
COPY . .
# `prepare` runs `prisma generate`, which writes the client and its query engine to
# src/lib/server/generated.
RUN CI=true pnpm install --frozen-lockfile --filter @petalnet/petalboard \
	&& pnpm --filter @petalnet/petalboard build
# A filtered install still links the workspace root's dev tooling. Ship only the production
# dependency tree: @prisma/client for the generated client, and the prisma CLI for
# `migrate deploy` at start.
RUN CI=true pnpm --filter @petalnet/petalboard deploy --prod /prod

FROM base
ARG MONOREPO_SHA=unknown
LABEL org.opencontainers.image.source=https://github.com/PetalNet/monorepo
LABEL org.opencontainers.image.revision=$MONOREPO_SHA
ENV NODE_ENV=production PORT=4173 DATABASE_URL=file:/app/data/dev.db
COPY --from=build /prod/node_modules /workspace/apps/petalboard/node_modules
COPY --from=build /workspace/apps/petalboard/package.json /workspace/apps/petalboard/package.json
COPY --from=build /workspace/apps/petalboard/prisma /workspace/apps/petalboard/prisma
COPY --from=build /workspace/apps/petalboard/build /workspace/apps/petalboard/build
# The bundled client loads its query engine from the generated directory.
COPY --from=build /workspace/apps/petalboard/src/lib/server/generated /workspace/apps/petalboard/src/lib/server/generated
WORKDIR /workspace/apps/petalboard
RUN mkdir -p /app/data
EXPOSE 4173
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && exec node build"]
