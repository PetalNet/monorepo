# Build from the monorepo root:
# docker build -f apps/astrolabe/Dockerfile -t astrolabe .
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS build

RUN npm install -g pnpm@12.11.2
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter=@petalnet/astrolabe... --ignore-scripts
WORKDIR /repo/apps/astrolabe
RUN pnpm exec svelte-kit sync && pnpm build
WORKDIR /repo
RUN pnpm deploy --filter=@petalnet/astrolabe --prod --config.inject-workspace-packages=true /out

FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5
RUN apk add --no-cache sqlite
WORKDIR /app
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/astrolabe/build ./build
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "build"]
