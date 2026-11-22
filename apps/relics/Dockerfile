# syntax=docker/dockerfile:1.29@sha256:572cebbc2b15e6f84c077742952674889cb63cd5e9b80abdffcbe587b6f19183
FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS build
WORKDIR /workspace
RUN npm install -g pnpm@12.21.0
COPY . .
RUN CI=true pnpm install --frozen-lockfile --filter @petalnet/relics... \
 && pnpm --filter @petalnet/relics check \
 && pnpm --filter @petalnet/relics test \
 && pnpm --filter @petalnet/relics build \
 && pnpm --filter @petalnet/relics deploy --prod /prod

FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1
ARG MONOREPO_SHA
LABEL org.opencontainers.image.source=https://github.com/PetalNet/monorepo
LABEL org.opencontainers.image.revision=$MONOREPO_SHA
ENV NODE_ENV=production PORT=4173 HOST=0.0.0.0 RELICS_DB=/app/data/dev.db RELICS_UPLOADS=/app/data/uploads BODY_SIZE_LIMIT=16M
WORKDIR /app
COPY --from=build /workspace/apps/relics/build ./build
COPY --from=build /prod/node_modules ./node_modules
COPY --from=build /workspace/apps/relics/package.json ./package.json
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 4173
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:4173/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","build"]
