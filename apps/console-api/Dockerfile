# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89
FROM node:26-bookworm-slim@sha256:e999d087492c7227c85adc70574cf9d3cce774c3e6d7b8dfe473ee6b142c8f2c AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN npm install --global pnpm@11.11.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/console-api/package.json apps/console-api/package.json
COPY packages/types/package.json packages/types/package.json
COPY packages/tsconfig/package.json packages/tsconfig/package.json
RUN pnpm install --frozen-lockfile --filter @petalnet/console-api...

COPY tsconfig.json ./
COPY apps/console-api apps/console-api
COPY packages/types packages/types
COPY packages/tsconfig packages/tsconfig
RUN pnpm --filter @petalnet/types build \
	&& pnpm --filter @petalnet/console-api build \
	&& pnpm --filter @petalnet/console-api deploy --prod --legacy /opt/console-api \
	&& rm -rf /opt/console-api/src /opt/console-api/test \
		/opt/console-api/Dockerfile /opt/console-api/tsconfig.json \
		/opt/console-api/vitest.config.ts /opt/console-api/.oxlintrc.json \
	&& find /opt/console-api/docs -mindepth 1 -maxdepth 1 \
		! -name contracts -exec rm -rf {} +

FROM node:26-bookworm-slim@sha256:e999d087492c7227c85adc70574cf9d3cce774c3e6d7b8dfe473ee6b142c8f2c AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN groupadd --system --gid 10001 console \
	&& useradd --system --uid 10001 --gid console --home-dir /app console
COPY --from=build --chown=console:console /opt/console-api/ ./

USER console
EXPOSE 8080
CMD ["sh", "-c", "node dist/bin/seed.js && exec node dist/server.js"]
