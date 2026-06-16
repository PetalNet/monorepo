# Stage 1: Build
FROM node:24-alpine@sha256:21f403ab171f2dc89bad4dd69d7721bfd15f084ccb46cdd225f31f2bc59b5c9a AS build

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN DATABASE_URL=file:placeholder.db pnpm build

# Stage 2: Runtime
FROM node:24-alpine@sha256:21f403ab171f2dc89bad4dd69d7721bfd15f084ccb46cdd225f31f2bc59b5c9a

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
