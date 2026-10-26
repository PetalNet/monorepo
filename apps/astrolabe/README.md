# Astrolabe

Astrolabe is a read-only, server-rendered lab status dashboard. It reads the local feeds and Kuma database on each request, while the browser revalidates the page every 30 seconds.

## Development

```sh
pnpm install
pnpm --filter @petalnet/astrolabe dev
```

The server accepts the existing deployment paths through `USAGE_PATH`, `CODEX_USAGE_PATH`, `BACKUP_LOG`, `KUMA_DB`, `HOST_HEALTH_PATH`, `MOOD_PATH`, `LAB_LAT`, and `LAB_LON`. Every input is optional at runtime: an unavailable source is represented locally as stale or awaiting data.

## Container

Build from the repository root so pnpm can use the workspace catalog and lockfile:

```sh
docker build -f apps/astrolabe/Dockerfile -t astrolabe .
```

The runtime image includes the `sqlite3` CLI because Kuma is read without a Node SQLite binding.
