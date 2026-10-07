# Grove schema changes

`src/lib/server/db/tables.ts` is the canonical effect-qb schema for runtime queries
and effect-db migration generation. Actor queries derive timestamp-free projections
from those same field definitions because effect-qb 0.24.1's public set operators
accept only portable sources. They do not maintain separate column definitions.

From `apps/grove`, with `DATABASE_URL` pointing to a disposable PostgreSQL database:

1. Run `pnpm migrate` to establish the completed migration history.
2. Change the canonical table definitions.
3. Run `pnpm exec effectdb push --dry-run` to inspect the schema diff, then
   `pnpm exec effectdb migrate generate --name <change>`. Add `--allow-destructive`
   only after reviewing the proposed destructive changes.
4. Review the generated SQL before applying it. Tweaks such as replacing a generated
   drop/add pair with a data-preserving rename belong at this stage. Review rollback
   behavior too; do not invent values for discarded data.
5. Run `pnpm migrate`, then `pnpm test` and `pnpm check`.

The initial migration is a fresh baseline generated with effect-db, replacing the
unused prerelease history before any deployment. Existing disposable databases need
to be recreated; there is no compatibility migration. Once this baseline is adopted,
completed migrations are immutable: generate a forward migration rather than editing history.

The generated baseline was reviewed to create and drop tables in foreign-key
dependency order, retain the public schema and CLI migration ledger on rollback,
and add the required Home Host and example-fern seed data. These are reviewed SQL
tweaks, not a custom generator or dependency patch.

The migration test exercises the upstream CLI's fresh install, repeat install,
rollback, and reinstall, and requires an empty effect-db schema diff across all
seventeen tables, including constraints, indexes, defaults, and foreign keys.

`0002_objects.sql` is the working `project.create` slice: Objects, append-only
Versions, the Project facet, principal-bound command receipts, and one atomic
outbox event per command. Only `project.create` is granted. Replay reauthorizes
against current Actor authority before returning the original receipt. Version
payloads use `task` for the ask and `role: 'project'`; receipts intentionally have
no JSON response column. The immutable baseline remains unchanged. Trigger
behavior (append-only Versions and durable Actor provenance) is reviewed SQL,
not representable in the canonical metadata.
