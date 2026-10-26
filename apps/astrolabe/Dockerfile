# Build from the monorepo root:
# docker build -f apps/astrolabe/Dockerfile -t astrolabe .
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS build

RUN corepack enable && corepack prepare pnpm@12.11.2 --activate
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter=@petalnet/astrolabe... --ignore-scripts
WORKDIR /repo/apps/astrolabe
RUN pnpm exec svelte-kit sync && pnpm build
WORKDIR /repo
RUN pnpm deploy --filter=@petalnet/astrolabe --prod --config.inject-workspace-packages=true /out

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd
RUN apk add --no-cache sqlite
WORKDIR /app
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/astrolabe/build ./build
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "build"]
