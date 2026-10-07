# Build from repository root on CI or a machine with disk headroom, NOT on .14.
FROM node:26.5.0-bookworm-slim AS build
WORKDIR /repo
RUN npm install --global pnpm@12.9.1
COPY . .
RUN pnpm install --frozen-lockfile --filter @petalnet/hey-janet... --ignore-scripts
RUN pnpm --filter @petalnet/hey-janet build
# adapter-node bundles dependencies; its generated package records externals.
RUN pnpm --filter @petalnet/hey-janet deploy --legacy --prod /out

FROM node:26.5.0-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=1000:1000 /out /app
USER 1000:1000
EXPOSE 3000
CMD ["node", "build"]
