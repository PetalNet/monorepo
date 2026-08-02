# Context map

This is the fetch-deeper index for the Grove handoff. Do not bulk-load the source export.

All paths below are relative to the original Grove preparation workspace, not this zip. The evidence summary in `CURRENT-IMPLEMENTATION-EVIDENCE.md` is sufficient for ordinary implementation planning.

## Current implementation

Load these first when verifying architecture:

| Need                                  | Source                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Authoritative source snapshot         | `sip-mega-export/console/_CURRENT-SOURCE-NOTE.md`                                                                  |
| Monorepo dependency rules             | `sip-mega-export/console/console-monorepo-current-daca287a/docs/ARCHITECTURE.md`                                   |
| Unified console architecture as built | `sip-mega-export/console/console-monorepo-current-daca287a/apps/console/docs/adr/UNIFIED-SVELTEKIT-CONSOLE.md`     |
| Console contracts                     | `sip-mega-export/console/console-monorepo-current-daca287a/apps/console/docs/contracts/CONSOLE-CONTRACTS.md`       |
| Current Postgres substrate            | `sip-mega-export/console/console-monorepo-current-daca287a/apps/console/migrations/0002_console_domain.sql`        |
| Current Library store/read model      | `sip-mega-export/console/console-monorepo-current-daca287a/apps/console/src/lib/server/domain/dashboard/store.ts`  |
| Legacy Task reads to replace          | `sip-mega-export/console/console-monorepo-current-daca287a/apps/console/src/lib/server/domain/reads/tracker.ts`    |
| Legacy Task commands to replace       | `sip-mega-export/console/console-monorepo-current-daca287a/apps/console/src/lib/server/domain/commands/tracker.ts` |
| Current Work-to-Library bridge        | `sip-mega-export/console/console-monorepo-current-daca287a/apps/console/src/routes/work/+page.ts`                  |
| Manager/fleet wire contracts          | `sip-mega-export/console/console-monorepo-current-daca287a/apps/manager/docs/contracts/CONTRACTS.md`               |
| Dispatcher decisions                  | `sip-mega-export/console/console-monorepo-current-daca287a/apps/dispatcher/DECISIONS-dispatcher.md`                |
| Control-plane decisions               | `sip-mega-export/console/console-monorepo-current-daca287a/apps/control-plane/DECISIONS-control-plane.md`          |
| Host executor decisions               | `sip-mega-export/console/console-monorepo-current-daca287a/apps/box-agent/DECISIONS-box-agent.md`                  |
| Matrix relay implementation           | `sip-mega-export/console/console-monorepo-current-daca287a/apps/courier/README.md`                                 |

## Product and UX decisions

| Need                                           | Source                                                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Full chronological Wayfinder/chat history      | `branch-mega-project-spec-merge.md`, principally lines 6,660-21,291                          |
| Final late Task/Version/recordicide correction | `branch-mega-project-spec-merge.md`, principally lines 20,607-21,010                         |
| Collaborative Room product seed                | `collab-rooms-inspiration.md.markdown`                                                       |
| Eli's UI craft bar                             | `eli-design-taste.md`                                                                        |
| Console Wayfinder decisions                    | `sip-mega-export/console/console-fable/WAYFINDER-DECISIONS.md`                               |
| Shared console foundations                     | `sip-mega-export/console/console-fable/specs/src/00-foundations.html`                        |
| Work surface brief                             | `sip-mega-export/console/console-fable/specs/briefs/05-work.md`                              |
| Library surface brief                          | `sip-mega-export/console/console-fable/specs/briefs/06-library.md`                           |
| Library routes as currently built              | `sip-mega-export/console/console-monorepo-current-daca287a/apps/console/src/routes/library/` |

## Historical material that is not authoritative

Use only to understand provenance or migration:

- `spec-package/SIP-MEGA-UNIFIED-SPEC.md`
- `spec-package/SIP-MEGA-MERGE-PLAN.md`
- `spec-package/SIP-MEGA-DECISION-LOG.md`
- `sip-mega-export/console/console-fable/`
- `sip-mega-export/console/console-read-canonical/`
- `partial-transcript-exports/`

These documents still use superseded concepts such as a separate Tracker, Records, or an older console/product boundary.

## Search recipes

Use narrow searches rather than loading directories:

```text
rg -n "library_items|library_item_revisions|library_links" <current-monorepo>
rg -n "task.claim|lease|fence|claimed_by" <current-monorepo>/apps
rg -n "Room|anchor Task|presence lease|Steward" branch-mega-project-spec-merge.md
rg -n "Version|Record|recordicide|Project Tasks automatically" branch-mega-project-spec-merge.md
```
