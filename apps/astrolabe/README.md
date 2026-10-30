# Astrolabe

Astrolabe is a read-only, server-rendered lab status dashboard. It reads the local feeds and Kuma database on each request, while the browser revalidates the page every 30 seconds.

## Development

```sh
pnpm install
pnpm --filter @petalnet/astrolabe dev
```

The server accepts the existing deployment paths through `USAGE_PATH`, `CODEX_USAGE_PATH`, `BACKUP_LOG`, `KUMA_DB`, `HOST_HEALTH_PATH`, `MOOD_PATH`, `LAB_LAT`, and `LAB_LON`. Every input is optional at runtime: an unavailable source is represented locally as stale or awaiting data.

## Codex usage feed

`feed/codex-usage-snapshot` writes `CODEX_USAGE_PATH`'s file on the host (default `/home/docker/.claude/shared/codex-usage.json`, override with `CODEX_USAGE_OUT`). Cron on .14 runs it every 5 minutes from a release checkout of `main`. It calls `feed/codex-usage --json`, which asks OpenAI for live rate limits through `codex app-server` (`account/rateLimits/read`, no tokens spent; `CODEX_BIN` overrides the binary) and falls back to the newest `~/.codex/sessions` rollout when that fails, with a warning on stderr. The JSON fields match `src/lib/server/dossier.ts`.

## Container

Build from the repository root so pnpm can use the workspace catalog and lockfile:

```sh
docker build -f apps/astrolabe/Dockerfile -t astrolabe .
```

The runtime image includes the `sqlite3` CLI because Kuma is read without a Node SQLite binding.
