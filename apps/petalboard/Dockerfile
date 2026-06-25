# syntax=docker/dockerfile:1.6

FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma

RUN corepack enable pnpm \
  && pnpm install --frozen-lockfile

FROM node:20-alpine AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
COPY src ./src
COPY static ./static
COPY svelte.config.js tsconfig.json vite.config.ts postcss.config.js tailwind.config.js .

RUN corepack enable pnpm \
  && pnpm exec prisma generate \
  && pnpm exec svelte-kit sync \
  && pnpm run build

FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4173
ENV DATABASE_URL="file:/app/data/dev.db"

RUN corepack enable pnpm \
  && mkdir -p data

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma

RUN pnpm exec prisma generate

EXPOSE 4173

CMD ["sh", "-c", "pnpm exec prisma migrate deploy && node build"]
