# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89
FROM node:26-bookworm-slim@sha256:e999d087492c7227c85adc70574cf9d3cce774c3e6d7b8dfe473ee6b142c8f2c AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN npm install --global pnpm@11.11.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/console/package.json apps/console/package.json
COPY packages/types/package.json packages/types/package.json
COPY packages/tsconfig/package.json packages/tsconfig/package.json
RUN pnpm install --frozen-lockfile --filter @petalnet/console...

COPY tsconfig.json vite.config.ts ./
COPY apps/console apps/console
COPY apps/console-api/docs/contracts apps/console-api/docs/contracts
COPY packages/types packages/types
COPY packages/tsconfig packages/tsconfig
RUN pnpm --filter @petalnet/types build \
	&& pnpm --filter @petalnet/console build \
	&& pnpm --filter @petalnet/console deploy --prod --legacy /opt/console-web \
	&& cp -R apps/console/build /opt/console-web/build \
	&& find /opt/console-web -mindepth 1 -maxdepth 1 \
		! -name build ! -name node_modules ! -name package.json -exec rm -rf {} +

FROM node:26-bookworm-slim@sha256:e999d087492c7227c85adc70574cf9d3cce774c3e6d7b8dfe473ee6b142c8f2c AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
WORKDIR /app

RUN groupadd --system --gid 10001 console \
	&& useradd --system --uid 10001 --gid console --home-dir /app console
COPY --from=build --chown=console:console /opt/console-web/ ./

USER console
EXPOSE 3000
CMD ["node", "build"]
