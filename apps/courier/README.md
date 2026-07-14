# courier

A reliability-first Matrix relay bot. Mirrors messages between configured
room clusters (E2EE-capable, media re-upload, reply threading), with a
plugin system (`!ping`, `!echo`, `!diag`, `!mode`, `!tools`, `!ai`).

Config-, env-, and data-compatible drop-in successor to `matrix-bot`
(matrix-ping-bot): the same `config.yaml` schema, the same `MATRIX_*`
environment variables, and the same on-disk state layout
(`session.json`, store directory, `relay-last-seen.json`,
`relay-delivery.json`, `history/`).

## Why it doesn't break

Reliability mechanisms are first-class, not bolted on:

| Mechanism | Where |
|---|---|
| Deadline + bounded retries on EVERY external call (sends, media download/upload, lookups, alias resolution, AI/MCP calls) | `courier-core/src/bound.rs`, used everywhere |
| Per-leg delivery health: per-destination success/failure tracking, pre-registered from config, periodic reports, loud `LEG IS DEAD` escalation, `!diag` | `courier-core/src/health.rs`, `courier/src/engine.rs` (reporter) |
| Fault isolation: every plugin invocation runs in its own task with a hard budget and panic containment | `courier-core/src/supervise.rs`, `courier/src/dispatch.rs` |
| Supervised sync loop: transient errors retry forever with capped backoff; only auth death exits (for restart + re-login) | `courier/src/engine.rs` |
| OS-thread watchdog (exit 70 on stalled sync loop) + startup guard — works even when the async runtime is wedged | `courier-core/src/watchdog.rs` |
| Idempotent relay: persisted per-(event, target) delivery ledger + stable transaction ids; restart/retry never loses or duplicates a message | `courier-relay/src/ledger.rs`, `courier-relay/src/idempotency.rs` |
| Ledger-driven startup backfill replays exactly what's missing | `courier-relay/src/lib.rs` |
| Per-source-room ordering: relay work is serialized per room via fair locks | `courier-relay/src/lib.rs` |

## Build

```sh
cargo build --release        # binary at target/release/courier
cargo test
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
```

## Run

Copy `.env.example` to `.env` and `config.example.yaml` to `config.yaml`,
then `cargo run --release`, or use Docker Compose (`docker compose up -d
--build`; state persists in `./data`). All flags are also environment
variables (`courier --help`); flags override env.

- `--check-config` parses and prints the config, then exits.
- `--mcp-server time` runs the internal MCP time server instead of the bot.
- `MATRIX_WATCHDOG_SECS=0` disables the stall watchdog (not recommended).
- The deprecated `MATRIX_SYNC_ITERATION_TIMEOUT_SECS` is accepted and
  ignored (a per-iteration sync timeout silently loses events).

## Cutover from matrix-bot

1. Stop nothing yet — build and `--check-config` against a copy of the
   existing `config.docker.yaml`.
2. Point `MATRIX_STORE` / `MATRIX_SESSION_FILE` (or the compose `./data`
   volume) at a COPY of the old data directory, or start fresh (fresh start
   = new device; re-login + `MATRIX_RECOVERY_KEY` restores E2EE history
   keys).
3. Stop the old container, start courier, watch for `Relay health` lines
   and run `!diag`.

## Renaming (courier is a placeholder)

1. `crates/courier/src/service.rs` — `SERVICE_NAME` (CLI name + default
   device display name).
2. Crate dirs + names: `crates/courier*` and the `[workspace.dependencies]`
   path entries, `--bin courier` in the Dockerfile, the compose
   `container_name`, the systemd unit, and the `courier=info,courier_ai=debug`
   log directives in `crates/courier/src/logging.rs` / deploy files.
3. `grep -ri courier` to catch stragglers. Everything else is name-neutral.

## Git hygiene

Do not commit secrets. `.gitignore` covers `.env`, `config.yaml`, `data/`,
the E2EE store, and `session.json`.
