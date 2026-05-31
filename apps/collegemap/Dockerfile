# Stage 1: Build
FROM node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920 AS build

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN DATABASE_URL=file:placeholder.db pnpm build

# Stage 2: Runtime
FROM node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=build /app/build ./build
COPY drizzle.config.ts ./
COPY src/lib/server/db/schema.ts ./src/lib/server/db/schema.ts
COPY docker-entrypoint.sh ./

RUN chmod +x docker-entrypoint.sh

ENV DATABASE_URL=file:/data/local.db
EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
