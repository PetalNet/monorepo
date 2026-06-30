# Build stage — compile better-sqlite3 (native) + run the SvelteKit build.
FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY package.json pnpm-workspace.yaml ./
RUN pnpm install --no-frozen-lockfile
# pnpm skips install scripts by default — force the native better-sqlite3 build.
RUN cd "$(find node_modules/.pnpm -type d -path '*/better-sqlite3' | grep -v '/node_modules/better-sqlite3/node_modules' | head -1)" && npm run install
COPY . .
RUN pnpm build

# Run stage.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/server.js ./
EXPOSE 8896
# custom server: SvelteKit handler + the fleet-terminal ws proxy (ws can't live in a +server route)
CMD ["node", "server.js"]
