FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS build
WORKDIR /app
COPY package.json ./
RUN npm install --global "$(node -p 'require("./package.json").packageManager')"
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @petalnet/turbo-cache...
RUN pnpm --filter @petalnet/turbo-cache build
RUN pnpm --filter @petalnet/turbo-cache deploy --prod --config.inject-workspace-packages=true /out

FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1
WORKDIR /app
COPY --from=build --chown=node:node /out ./
RUN mkdir /state && chown 1001:1001 /state
USER node
EXPOSE 3001
CMD ["node", "dist/src/main.js"]
