# Build from the monorepo root:
# docker build -f apps/astrolabe/Dockerfile -t astrolabe .
FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS build

RUN corepack enable && corepack prepare pnpm@12.11.2 --activate
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter=@petalnet/astrolabe... --ignore-scripts
WORKDIR /repo/apps/astrolabe
RUN pnpm exec svelte-kit sync && pnpm build
WORKDIR /repo
RUN pnpm deploy --filter=@petalnet/astrolabe --prod --config.inject-workspace-packages=true /out

FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94
RUN apk add --no-cache sqlite
WORKDIR /app
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/astrolabe/build ./build
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "build"]
