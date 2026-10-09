# Grove schema changes

`src/lib/server/db/tables.ts` is the canonical Drizzle pg-core schema. Both
`drizzle-orm` and `drizzle-kit` use the matching npm preview
`1.0.0-rc.5-5935859` from upstream PR #5966. Domain timestamps remain strings and
int8 identities use native `bigint({ mode: "string" })` for lossless, JSON-safe
strings. The application driver normalizes Effect PgClient's int8 bigint values
to strings through Drizzle's codec configuration; Better Auth timestamps use
Date-mode driver codecs. Effect PgClient owns
connections and transactions, including migration execution. The preview's
Effect driver declarations need the upstream stable Effect SQL import compatibility
patch; that type-only patch does not change runtime behavior, schema metadata or
completed SQL. Kit resolves the same ORM preview through a pnpm package extension.

From `apps/grove`, with `DATABASE_URL` set:

1. Run `pnpm exec node migrations/runner.ts up` (also `pnpm migrate`) to establish
   or adopt the completed migration history. Existing databases are NOT recreated.
2. Change the canonical table definitions.
3. Run `pnpm exec drizzle-kit generate --name <change>`. The checked-in
   `generated/20261009055447_adoption/snapshot.json` adopts the current 23-table
   schema in the RC's version-8 snapshot format; its no-op `migration.sql` is
   metadata staging only, not an executable baseline. This RC uses timestamped
   directories containing `snapshot.json` and `migration.sql`, not a meta journal.
   Generation with unchanged definitions must report no schema changes.
4. Review the staged SQL in `generated/`, then copy the forward SQL into the next
   root migration (`0005_<change>.sql` initially), with `-- effect-db:up` and a
   reviewed `-- effect-db:down` section. Retain generated snapshot directories for
   the next diff, but only root numbered SQL files are executable history.
   Preserve data with renames/backfills rather than generated drop/add pairs.
   Add seed changes, triggers and deferrability explicitly: Drizzle metadata does
   not represent these. Never use `drizzle-kit push` or its migrator on Grove.
5. Run `pnpm migrate`, then `pnpm test` and `pnpm check`.

Completed migrations 0001..0004 remain byte-for-byte immutable. The runner retains
`effect_qb_migrations` (ids, names, SHA-256 checksums and applied timestamps), checks
existing checksums and fills legacy null checksums without rerunning SQL. There is
no separate Drizzle execution ledger. Every command holds a transaction-scoped advisory
lock and applies/rolls back SQL and ledger changes atomically. For a reviewed
downgrade use `pnpm exec node migrations/runner.ts down <steps>`; provenance guards
can refuse a downgrade without discarding data.

The generated baseline was reviewed to create and drop tables in foreign-key
dependency order, retain the public schema and CLI migration ledger on rollback,
and add the required Home Host and example-fern seed data. These are reviewed SQL
tweaks, not a custom generator or dependency patch.

The migration test exercises the runner's fresh install, repeat install, rollback,
reinstall and failed procedural SQL. It compares PostgreSQL-normalized catalogs
against a disposable reference schema generated from Drizzle across all 23 tables:
columns, identities, defaults, constraints, indexes and foreign keys. The outbox
deferred FK is supplied as reviewed SQL in the reference, and domain trigger
behavior is checked separately. No reference schema is applied to a real database.
The installed RC's `foreignKey` declarations still expose only update/delete
actions, not deferrability, so this reference adjustment remains necessary.
Catalog generation uses `drizzle-kit/api-postgres` and awaits `generateDrizzleJson`.

`0002_objects.sql` is the working `project.create` slice: Objects, append-only
Versions, the Project facet, principal-bound command receipts, and one atomic
outbox event per command. Only `project.create` is granted. Replay reauthorizes
against current Actor authority before returning the original receipt. Version
payloads use `task` for the ask and `role: 'project'`; receipts intentionally have
no JSON response column. The immutable baseline remains unchanged. Trigger
behavior (append-only Versions and durable Actor provenance) is reviewed SQL,
not representable in the canonical metadata.

`0003_task_execution.sql` adds bounded one-shot planning, dependency readiness,
exclusive expiring Claims, separate Attempts, and immutable output publication.
It backfills only these execution capabilities for existing Actors and preserves
existing project receipts exactly. Publication does not complete Tasks; review,
completion, and library operations are not implemented in these two slices.
The reviewed rename preserves Project facets, and receipt response backfill
supports exact authorized replay. Downgrade refuses non-representable execution
history atomically rather than discarding it. Capability edits survive rollback.

`0004_review_library.sql` closes the working loop: independent review of an exact
artifact Version, expected-head Task completion, and project-scoped library
search and pinned retrieval. Only this slice grants review, completion, and
library capabilities. Acceptance alone does not complete a Task or unblock its
dependents; explicit completion appends a Version citing the accepted Attempt,
output, and Review. Historical library citations survive later heads. Review,
output, and completion provenance is immutable, and downgrade refuses to erase
review history. These domain triggers are exercised separately from schema diff.
