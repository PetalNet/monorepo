# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89

FROM node:26-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN npm install --global pnpm@11.11.0

COPY . .
RUN pnpm install --frozen-lockfile --filter @petalnet/console...

RUN DATABASE_URL=postgresql://placeholder@localhost:5432/placeholder \
      pnpm --filter @petalnet/console... run build

RUN pnpm --filter @petalnet/console deploy --prod --legacy /opt/console \
    && cp -R apps/console/build /opt/console/build \
    && cp -R apps/console/migrations /opt/console/migrations \
    && cp apps/console/effectdb.config.ts /opt/console/effectdb.config.ts

FROM node:26-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
WORKDIR /app

RUN groupadd --system --gid 10001 console \
    && useradd --system --uid 10001 --gid console --home-dir /app console
COPY --from=build --chown=console:console /opt/console/ ./
COPY --from=build --chown=console:console /workspace/apps/console/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER console
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=5 \
  CMD node -e "require('node:net').connect(Number(process.env.PORT||3000),'127.0.0.1').on('connect',function(){process.exit(0)}).on('error',function(){process.exit(1)})"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
