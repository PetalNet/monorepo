# FABLE-BRIEF — N1.5: tasks Live Fleet Cockpit + Auto-Capture (harness rewrite, Phase 1)

> **Node class: MERGE/HARDEN** — cockpit v1 shipped (tracker task-242 in review; live
> `/fleet` route + lifecycle-hook auto-capture). This node closes 242's review gaps and
> builds 243 (per-subagent live progress stream) + fleet-event contract adoption. No
> Parker gate.
>
> **Build weight: MODERATE** — Node/SvelteKit/pnpm. `pnpm vite build` is allowed in the
> morning burn but run it ONCE at the end, niced; use `vite dev`-less unit tests
> (vitest/node) for iteration. No `pnpm install` of heavy new deps.

## §0 — How to work (fully autonomous, unattended, no human mid-run)
- You are **Fable**, running alone. Brief = source of truth. Pick-and-log free choices into
  `DECISIONS-N1.5.md` at the tasks repo root on your branch; never block.
- Repo: `/home/docker/tasks`. New branch **`feat/N1.5-fleet-cockpit`** from `main`. Commit
  locally per phase; do NOT push; no PR.
- **REVIEWABLE-ONLY**: the tasks app + its SQLite DB are LIVE (docker-compose; the cockpit
  is in use). Do NOT restart the container, do NOT write to `/home/docker/tasks/data/`
  (tasks.db, fleet/*.json) — tests use a temp-dir DB via `TASKS_DB_PATH` (db.js already
  honors it) and a temp fleet dir. Do not touch `docker-compose*.yml` behavior.
- **Build budget:** vitest/node unit runs freely (light); ONE `pnpm build` (niced) at the
  end to prove the app compiles. No new heavy dependencies; registry may be unreachable
  from .14 — if `pnpm install` is needed for a new dep, it probably can't happen tonight;
  design around the existing node_modules and log anything descoped.

## Mission
Make the fleet cockpit fully live and contract-clean: adopt the N0.1 `fleet-event` v1
contract (producer-normalized handle/host, `event`, `task_id`, `schema_version`) with v0
tolerance, close the 242 review items, and ship 243 — a per-subagent live progress stream
(what each running subagent/workflow is doing, token/time spend) into the cockpit, fed by
the same zero-manual-publish hook pipeline.

## LOCKED decisions (do not relitigate)
- The fleet-event contract is
  `/home/docker/janet-manager/docs/contracts/schemas/fleet-event.schema.json`: producers
  write canonical lowercase handle + canonical host ('.N', never 'dotN'), `offline` is
  ALWAYS consumer-derived from `updated_at` staleness (90s), snapshot file = latest event.
  v0 files (no `schema_version`) stay readable — the consumer keeps its normalizations as
  a compatibility layer, clearly marked as v0-only.
- Tracker is the source of truth: focus = active lease join (`activeLeases()`); the new
  `task_id` field on events is an additive signal, not a replacement (contracts open
  question #5 — implement BOTH: use event task_id when present, fall back to the join).
- Zero manual publish: everything the cockpit shows arrives from hooks/DB automatically.
- The whole known fleet renders (roster stubs for never-seen agents — Eli: "the rest of
  them exist"); live files win over roster.
- `claim_token` NEVER reaches the browser (db.js SECRET_COLS scrub stays absolute);
  lease/`leasePublic` fields (worker, expiry) are fine and drive swimlanes/countdowns.
- Visibility rules (`vis(me)`) apply to everything task-shaped the cockpit joins in.

## Read first (ground truth, all local)
- `src/lib/server/fleet.js` — the whole consumer (roster, staleness, normalization, focus
  join, totals). This is what adopts the v1 contract.
- `data/fleet/*.json` — live v0 producer output (note janet.json's `host: "dot14"` — the
  drift the producer contract kills).
- `src/lib/server/db.js` — `activeLeases`, SECRET_COLS/deepScrub, events table, trimEventData
  (the audit-event size discipline 243's stream must respect).
- `src/routes/fleet/` — the cockpit UI v1; `src/routes/api/` — existing API surface.
- `mjs/` (the hooks package: lib/, src/, queue.mjs history at repo root `git log --oneline
  -- mjs/`) — the lifecycle-hook producer side that writes fleet files; this is where v1
  emission (event, task_id, schema_version, canonical host) lands. The hook that runs on
  202 (`/home/agent/.claude/hooks/fleet-event.mjs`) is deployed FROM here — you change the
  source here only; deployment to 202 is the launcher's morning step (note it in DECISIONS).
- Tracker task ledger for scope: 242 (review — read its comments/events via
  `sqlite3 data/tasks.db "SELECT * FROM comments WHERE task_id=242"` read-only), 243 (inbox).
- `/home/docker/janet-manager/docs/contracts/CONTRACTS.md` §3 + DECISIONS.md D11.
- DAG plan (gallery `harness-rewrite-dag-plan`) — N1.5 scope line.

## Deliverables (branch `feat/N1.5-fleet-cockpit`, local commits only)
1. **Producer v1** (hook source in this repo): emit `schema_version:1`, `event`, `task_id`
   (from the claimed task when the hook environment knows it — read the lease by
   handle via a small query helper; null otherwise), canonical handle/host. Unit tests on
   the emission shape against the schema's required set (plain JSON assertions — no new
   schema-validation dep).
2. **Consumer v1+v0**: fleet.js accepts both; v1 events skip normalization (assert-only);
   v0 keeps today's fixups. `event` surfaces in the UI tooltip (e.g. "post_tool 4s ago").
   Focus resolution: event.task_id first, activeLeases fallback.
3. **243 — per-subagent stream**: a `fleet/<handle>.subagents.json` (or equivalent
   pick-and-log shape) written by the hooks when subagents/workflows run: per-subagent
   {label, started_at, updated_at, last_tool, tokens_spent?}; cockpit renders an expandable
   per-agent drill-down with live counts. Respect trimEventData-style size discipline
   (bounded entries, no giant payloads). Stale subagent entries age out server-side.
4. **242 review closure**: read task-242's review feedback from the tracker (read-only)
   and fix what's in-scope for the cockpit; list each item → fixed/deferred in DECISIONS.
5. **Tests**: fleet.js unit tests (temp dirs/DB): staleness edge, v0+v1 mixed dir, roster
   fold-in, subagent aging, secret-scrub still holds on every new API payload.
6. `DECISIONS-N1.5.md` — choices, 242-item disposition, §0 compliance, the 202-deploy note,
   one final `pnpm build` result.

## Phased order
1. Read ground truth + task-242 review comments; findings + plan → DECISIONS; commit.
2. Producer v1 emission + tests; commit.
3. Consumer v1/v0 + UI surfacing; commit.
4. 243 subagent stream (producer + consumer + UI); commit.
5. 242 leftovers; commit.
6. Test pass + single build; final DECISIONS; commit.

## Stack / constraints
SvelteKit + better-sqlite3 + the existing mjs hook package. No new runtime deps. All DB
access through db.js patterns (WAL, visibility, scrubbing). UI follows the existing fleet
board idioms — this is a harden-and-extend, not a redesign.
