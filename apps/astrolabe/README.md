# Astrolabe

Astrolabe is a read-only, server-rendered lab status dashboard. It reads the local feeds and Kuma database on each request, while the browser revalidates the page every 30 seconds.

## Development

```sh
pnpm install
pnpm --filter @petalnet/astrolabe dev
```

The server accepts the existing deployment paths through `USAGE_PATH`, `CODEX_USAGE_PATH`, `QUOTA_USAGE_PATH`, `BACKUP_LOG`, `KUMA_DB`, `HOST_HEALTH_PATH`, `MOOD_PATH`, `LAB_LAT`, and `LAB_LON`. `KUMA_URL` is the Uptime Kuma base URL the services section links to; without it, down monitors are named but not linked. Every input is optional at runtime: an unavailable source is represented locally as stale or awaiting data.

## Usage limits

Each provider gets one plate: its plan, then a row for every limit its feed reports, such as Claude's weekly and Fable weekly limits or Codex's 5-hour and weekly ones. Claude and Codex come first, then each other service in the quota feed. The dials draw the 5-hour and 7-day windows as rings in that order, two on the day dial and three on the week dial; a row whose limit has a ring carries a pip in the ring's colour. Nothing about a plan is configured: a window appears or disappears with the feed, and the plan comes from it too. Codex's is the `plan` its feed carries (`planType`). Claude's is `subscription_type` and `rate_limit_tier` in `USAGE_PATH`; a snapshot without them shows no plan. `src/lib/plans.ts` maps both to display names such as Pro 100 or Ultra. A Claude limit kind Astrolabe doesn't read is noted on Claude's plate rather than hidden.

Claude's windows come from the `raw` usage response in `USAGE_PATH` (`five_hour`, `seven_day`, and the `weekly_scoped` entries of `limits`), since the top-level `five_hour_pct` reads 0 when there is no 5-hour window at all.

## Quota feed

`QUOTA_USAGE_PATH` (default `/shared/quotas/quota-usage.json`) is an optional feed that one host job writes for any number of services. Every service in it other than `claude` and `codex` gets a plate; those two have their own feeds, which say more about their limits.

```json
{
	"generatedAt": 1795121040000,
	"services": [
		{
			"service": "google-ai",
			"label": "Google AI",
			"status": "ok",
			"limits": [
				{
					"id": "google-ai:gemini-models:5h",
					"label": "Gemini models 5-hour",
					"usedPct": 90,
					"resetAtMs": 1795149291000,
					"windowMinutes": 300
				}
			]
		}
	]
}
```

`generatedAt` and `resetAtMs` are epoch milliseconds. `service` is an id of letters, digits, `.`, `_` and `-`, listed once; `label` is its display name, and a service without one shows its id. `status` is `ok`, `signed-out` or `error`, and the last two show on the plate as "Signed out" and "Reading failed". A limit's `label` names its row. `usedPct` may be fractional and may pass 100. `resetAtMs` and `windowMinutes` are optional: a limit with a reset and a `windowMinutes` of 300 or 10080 is a 5-hour or 7-day window, which can take a ring and gets a pace projection. Any other limit is a row with its usage and reset alone. The id's suffix decides nothing.

Other fields are ignored, so a service's error text never reaches the page. A feed that is not this shape, or is dated in the future, shows one "Quota feed" plate reading "Reading failed" rather than figures that might be wrong. No file shows no plates. Figures more than 15 minutes old are marked with their age, and a figure whose limit has since reset is dropped.

Compose mounts the directory `/home/docker/.claude/shared/astrolabe-quota` rather than the file, so the job can replace the file by renaming a new one over it. Create the directory as the job's user before starting the container; Docker otherwise creates it owned by root.

## Feed scripts

The scripts in `feed/` run on the host, where the logins are, and write the files the container reads. They are TypeScript with no dependencies, which Node runs from a checkout by stripping the types: no install or build step, and Node 22.18 or newer. `pnpm test` runs their tests with the app's.

## Claude usage feed

`feed/claude-usage-snapshot.ts` writes `USAGE_PATH`'s file on the host (default `/home/docker/.claude/shared/janet-usage.json`, override with `CLAUDE_USAGE_OUT`). Cron on .14 runs it every 2 minutes from a release checkout of `main`. It runs `/home/docker/.claude/bin/usage-fetch.js`, which reads a claude.ai session key and organization id from `~/.config/claude-matrix-channel/usage.toml` and asks claude.ai for that organization's usage, and keeps the whole response as `raw`. The usage response names no plan, so the script adds `subscription_type` and `rate_limit_tier` from the Claude Code login (`subscriptionType` and `rateLimitTier` under `claudeAiOauth` in `~/.claude/.credentials.json`); the login's tokens never reach the snapshot. Nothing checks that the session key and the login belong to one account: where they differ, the plate shows one account's usage under the other's plan. It then copies the snapshot to the agent VM over SSH, which may fail without failing the run.

## Codex usage feed

`feed/codex-usage-snapshot.ts` writes `CODEX_USAGE_PATH`'s file on the host (default `/home/docker/.claude/shared/codex-usage.json`, override with `CODEX_USAGE_OUT`). Cron on .14 runs it every 5 minutes from a release checkout of `main`. It writes what `feed/codex-usage.ts --json` prints: that script asks OpenAI for live rate limits through `codex app-server` (`account/rateLimits/read`, no tokens spent; `CODEX_BIN` overrides the binary) and falls back to the newest `~/.codex/sessions` rollout when that fails, with a warning on stderr. The JSON fields match `src/lib/server/dossier.ts`.

## Container

Build from the repository root so pnpm can use the workspace catalog and lockfile:

```sh
docker build -f apps/astrolabe/Dockerfile -t astrolabe .
```

The runtime image includes the `sqlite3` CLI because Kuma is read without a Node SQLite binding.
