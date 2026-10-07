FROM node:26.5.0-bookworm-slim AS build
WORKDIR /repo
RUN npm install --global pnpm@12.9.1
COPY . .
RUN pnpm install --frozen-lockfile --filter @petalnet/hey-janet... --ignore-scripts
RUN pnpm --filter @petalnet/hey-janet build
RUN pnpm --filter @petalnet/hey-janet deploy --legacy --prod /out

FROM node:26.5.0-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=1000:1000 /out /app
USER 1000:1000
EXPOSE 3000
CMD ["node", "build"]
