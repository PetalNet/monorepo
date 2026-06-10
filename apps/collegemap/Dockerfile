# Stage 1: Build
FROM node:24-alpine@sha256:fb71d01345f11b708a3553c66e7c74074f2d506400ea81973343d915cb64eef0 AS build

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN DATABASE_URL=file:placeholder.db pnpm build

# Stage 2: Runtime
FROM node:24-alpine@sha256:fb71d01345f11b708a3553c66e7c74074f2d506400ea81973343d915cb64eef0

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
