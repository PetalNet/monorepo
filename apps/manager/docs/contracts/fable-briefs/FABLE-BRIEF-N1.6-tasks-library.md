# FABLE-BRIEF — N1.6: tasks Library — docs + gallery unification (harness rewrite, Phase 1)

> **Node class: RE-PORT (greenfield-leaning).** The DAG plan is explicit: the old branch is
> "on branch, stale — needs **re-port not merge**". `feat/docs-gallery` (tip c4db004,
> library-unify commit 8628662) predates months of main-branch churn (agent-api merge, FTS
> search, archive/restore, events-log bounding). Use it as the DESIGN reference; write the
> code fresh against today's `main`. Do not attempt a merge. No Parker gate.
>
> **Build weight: MODERATE** — Node/SvelteKit/pnpm, same budget rules as N1.5. No new deps
> expected.

## §0 — How to work (fully autonomous, unattended, no human mid-run)

- You are **Fable**, running alone. Brief = source of truth. Pick-and-log free choices into
  `DECISIONS-N1.6.md` at the tasks repo root on your branch; never block.
- Repo: `/home/docker/tasks`. New branch **`feat/N1.6-library-reportv2`** from `main`.
  Commit locally per phase; do NOT push; no PR.
- **REVIEWABLE-ONLY**: live app + live DB — do NOT restart the container, do NOT write to
  `/home/docker/tasks/data/`; tests run on a temp DB via `TASKS_DB_PATH`. Read the old
  branch with `git show`/`git diff` only — never check it out over your work.
- **Build budget:** vitest/node freely; ONE niced `pnpm build` at the end. Registry likely
  unreachable — no new deps.

## Mission

Re-port task-515: unify `/docs` (tracker docs: briefs/ADRs/research, `kind='doc'` rows) and
`/gallery` (the artifacts table: markdown/html/interactive) into ONE Library knowledge
surface with a kind-filter — one place to browse everything written, regardless of which
store it lives in — rebuilt cleanly on today's main (post agent-api, post FTS, post
archive), preserving every hard-won invariant main has grown since the stale branch.

## LOCKED decisions (do not relitigate)

- Re-port, not merge (DAG plan). The stale branch is reference material only.
- Both stores stay: tracker `tasks` rows with `kind='doc'` AND the `artifacts` table.
  Library is a unified VIEW over them, not a data migration (no schema unification burn
  tonight — if you conclude one is warranted, that's a DECISIONS note for Parker, not code).
- Visibility is absolute: `vis(me)` for doc rows, `visibility` column for artifacts —
  private items never leak into a shared Library listing (regression #285 class).
- FTS search (task-633, on main) must cover the Library listing; do not fork a second
  search path if the existing one can be extended.
- Existing URLs keep working: `/docs` and `/gallery` routes either redirect into the
  Library or render it filtered — no dead links from tracker task bodies or Matrix history.
- `claim_token`/SECRET_COLS scrubbing applies to any task-shaped payload the Library ships.

## Read first (ground truth, all local)

- The stale design: `git -C /home/docker/tasks show 8628662` (the unify commit) and
  `git diff main...feat/docs-gallery --stat` — what it changed, which parts still map.
- `src/routes/docs/`, `src/routes/gallery/`, `src/routes/browse/` on main — today's
  surfaces to unify.
- `src/lib/server/db.js` — `listDocs`, `allDocs`, artifacts queries, FTS (`tasks_fts`),
  `vis(me)`, NOTARCHIVED, the archive/restore additions (c4db004 excluded archived
  projects from agent-facing queries — the Library must respect the same).
- `data/tasks.db` (read-only sqlite3): `.schema artifacts`, row counts per kind/visibility
  to size the listing.
- Tracker task 515 (status: review — read its body + comments read-only for Eli's intent).
- DAG plan N1.6 line (gallery `harness-rewrite-dag-plan`).

## Deliverables (branch `feat/N1.6-library-reportv2`, local commits only)

1. **`/library` route**: one listing over docs + artifacts — kind filter (doc / brief /
   research / gallery-markdown / gallery-html / interactive), project filter where
   applicable, sort by updated, FTS search hook-in, visibility-safe, archived-excluded.
2. **Unified card model** (`src/lib/server/library.js` or similar): one normalized shape
   {source: task|artifact, id, slug/route, title, kind, description/excerpt, owner,
   visibility, updated_at} with unit tests incl. a private-item leak test and an
   archived-project exclusion test.
3. **Route continuity**: `/docs` + `/gallery` render Library pre-filtered (or 3xx into
   it — pick-and-log); every old deep link (`/gallery/<slug>`, `/task/<id>`) resolves.
4. **Re-port audit table** in DECISIONS: every change in 8628662 → adopted / superseded-by-
   main / dropped (with why). This is what makes re-port reviewable against the old branch.
5. Tests green (vitest, temp DB) + ONE `pnpm build`; `DECISIONS-N1.6.md` with choices +
   §0 compliance.

## Phased order

1. Diff-study the stale branch vs main; write the re-port audit plan; commit.
2. Unified card model + tests; commit.
3. `/library` route + filters + FTS; commit.
4. Route continuity + leak/archive tests; commit.
5. Build pass; final DECISIONS; commit.

## Stack / constraints

SvelteKit + better-sqlite3, existing design-system idioms (match the current board/docs
pages' look — no new CSS framework). No new deps. Data stays where it is.
