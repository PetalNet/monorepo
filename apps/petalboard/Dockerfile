# syntax=docker/dockerfile:1.29@sha256:572cebbc2b15e6f84c077742952674889cb63cd5e9b80abdffcbe587b6f19183
# Build from the repository root: docker build -f apps/petalboard/Dockerfile -t petalboard .
FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS base
# Prisma's engines link against OpenSSL.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates openssl \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /workspace

FROM base AS build
RUN npm install -g pnpm@12.11.2
COPY . .
# `prepare` runs `prisma generate`, which writes the client to src/lib/server/generated.
RUN CI=true pnpm install --frozen-lockfile --filter @petalnet/petalboard \
	&& pnpm --filter @petalnet/petalboard build
# A filtered install still links the workspace root's dev tooling. Ship only the production
# dependency tree: @prisma/client and the SQLite driver adapter for the generated client, and
# the prisma CLI for `migrate deploy` at start.
RUN CI=true pnpm --filter @petalnet/petalboard deploy --prod /prod

FROM base
ARG MONOREPO_SHA=unknown
LABEL org.opencontainers.image.source=https://github.com/PetalNet/monorepo
LABEL org.opencontainers.image.revision=$MONOREPO_SHA
ENV NODE_ENV=production PORT=4173 DATABASE_URL=file:/app/data/dev.db
COPY --from=build /prod/node_modules /workspace/apps/petalboard/node_modules
COPY --from=build /workspace/apps/petalboard/package.json /workspace/apps/petalboard/package.json
COPY --from=build /workspace/apps/petalboard/prisma /workspace/apps/petalboard/prisma
COPY --from=build /workspace/apps/petalboard/prisma.config.ts /workspace/apps/petalboard/prisma.config.ts
COPY --from=build /workspace/apps/petalboard/build /workspace/apps/petalboard/build
WORKDIR /workspace/apps/petalboard
RUN mkdir -p /app/data
EXPOSE 4173
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && exec node build"]
