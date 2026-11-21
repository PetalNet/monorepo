# Astrolabe

Astrolabe is a read-only, server-rendered lab status dashboard. It reads the local feeds and Kuma database on each request, while the browser revalidates the page every 30 seconds.

## Development

```sh
pnpm install
pnpm --filter @petalnet/astrolabe dev
```

The server accepts `QUOTA_USAGE_PATH`, `BACKUP_LOG`, `KUMA_DB`, `HOST_HEALTH_PATH`, `MOOD_PATH`, `LAB_LAT`, and `LAB_LON`. `KUMA_URL` is the Uptime Kuma base URL the services section links to. Unavailable sources are shown as unavailable or stale.

## Quota feed

The dashboard reads `/shared/quota-usage.json` by default. The producer must provide a JSON object with `generatedAt` in epoch milliseconds and a `services` array. Each service has `service`, `status` (`ok`, `signed-out`, or `error`), and `limits`. Each limit has `id`, `label`, and `usedPct`, with optional `resetAtMs` and `resetLabel`. The feed must exclude account data, summaries, errors, and credentials. Compose mounts `/home/docker/.claude/shared/astrolabe-quota` read-only; provision the directory before starting the container.

The feed is stale after 15 minutes. Stale figures and figures for windows that have reset are hidden. Five-hour and seven-day limits identified by `:5h` and `:7d` suffixes can appear on the dials; all limits appear on plaques. Ollama Cloud is listed as having no limit feed until a report is available.

## Container

Build from the repository root so pnpm can use the workspace catalog and lockfile:

```sh
docker build -f apps/astrolabe/Dockerfile -t astrolabe .
```

The runtime image includes the `sqlite3` CLI because Kuma is read without a Node SQLite binding.
