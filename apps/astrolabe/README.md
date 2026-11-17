# Astrolabe

Astrolabe is a read-only, server-rendered lab status dashboard. It reads the local feeds and Kuma database on each request, while the browser revalidates the page every 30 seconds.

## Development

```sh
pnpm install
pnpm --filter @petalnet/astrolabe dev
```

The server accepts the existing deployment paths through `USAGE_PATH`, `CODEX_USAGE_PATH`, `CLAUDE_PLAN`, `CODEX_PLAN`, `BACKUP_LOG`, `KUMA_DB`, `HOST_HEALTH_PATH`, `MOOD_PATH`, `LAB_LAT`, and `LAB_LON`. `KUMA_URL` is the Uptime Kuma base URL the services section links to; without it, down monitors are named but not linked. Every input is optional at runtime: an unavailable source is represented locally as stale or awaiting data.

## Plans

`src/lib/plans.ts` lists the limit windows each plan has (`PLANS`), such as Claude Max 20x's weekly and Fable weekly limits Codex Plus's 5-hour and weekly ones or Codex Pro's (`prolite`) weekly one. `DEFAULT_PLANS` picks the plans in use; `CLAUDE_PLAN` and `CODEX_PLAN` override them. The dials and plaques draw the windows the active plans list and fill them from the live feeds. A window the plan lists that the feed doesn't report, one the feed reports that the plan doesn't list, a Codex plan other than the configured one, or a Claude limit kind Astrolabe doesn't read is shown flagged rather than hidden. A plan missing from the table gets a warning and the windows its feed reports.

Claude's windows come from the `raw` usage response in `USAGE_PATH` (`five_hour`, `seven_day`, and the `weekly_scoped` entries of `limits`), since the top-level `five_hour_pct` reads 0 when there is no 5-hour window at all.

## Codex usage feed

`feed/codex-usage-snapshot` writes `CODEX_USAGE_PATH`'s file on the host (default `/home/docker/.claude/shared/codex-usage.json`, override with `CODEX_USAGE_OUT`). Cron on .14 runs it every 5 minutes from a release checkout of `main`. It calls `feed/codex-usage --json`, which asks OpenAI for live rate limits through `codex app-server` (`account/rateLimits/read`, no tokens spent; `CODEX_BIN` overrides the binary) and falls back to the newest `~/.codex/sessions` rollout when that fails, with a warning on stderr. The JSON fields match `src/lib/server/dossier.ts`.

## Container

Build from the repository root so pnpm can use the workspace catalog and lockfile:

```sh
docker build -f apps/astrolabe/Dockerfile -t astrolabe .
```

The runtime image includes the `sqlite3` CLI because Kuma is read without a Node SQLite binding.
