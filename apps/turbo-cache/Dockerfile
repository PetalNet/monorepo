FROM node:26.5.0-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @petalnet/turbo-cache...
RUN pnpm --filter @petalnet/turbo-cache build
RUN pnpm --filter @petalnet/turbo-cache deploy --prod --config.inject-workspace-packages=true /out

FROM node:26.5.0-bookworm-slim
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3001
CMD ["node", "dist/src/main.js"]
