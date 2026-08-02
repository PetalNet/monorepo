# Rectified decision register

**Rule:** `01-GROVE-BUILD-SPEC.md` is normative. This register explains which historical ideas it adopts, changes, or rejects.

## Adopted

1. Grove is one installed and operated service of internally bounded parts.
2. The current monorepo snapshot `daca287a` is the implementation base.
3. The full-stack console remains one SvelteKit server with one Effect domain layer exposed through Remote Functions, REST/OpenAPI, MCP, and WebSockets.
4. Deployable internal components do not import other deployable components' implementation details; shared contracts belong in neutral packages/crates.
5. The Library is the universal Grove object graph and shared PKM substrate.
6. Personal and Grove are the two normal visibility realms; narrower access uses explicit ACL exceptions.
7. The Grove Librarian stewards shared knowledge. Personal Librarians and UI agents are private user-scoped by default.
8. Project work consumes from and contributes accepted durable outputs back to the Grove Library.
9. Every durable object has stable identity, immutable Versions, content hashes, signatures, provenance, and typed links.
10. A Project is a Task with the `project` role.
11. Tasks form a DAG, support arbitrarily deep child Tasks, and may represent human, agent, or automated action.
12. Tasks, Attempts, and Claims have separate lifecycles.
13. A successful Attempt submits a result; a Task completes only under its completion and verification policies.
14. Workflows are optional execution mechanics beneath Attempts, not the work domain model.
15. Every explicit agent invocation creates a Task; routine execution details do not become Tasks.
16. Rooms are Task-anchored collaboration contexts with free conversation and explicit official operations.
17. Matrix remains the continuity transport and supports BYO compatible clients and federated accounts.
18. Non-collaboration Matrix channels are bus projections, notification channels, or typed transport lanes, not Grove Rooms.
19. Agents are one universal primitive composed from role, scope, lifecycle, grants, memory, model, placement, and supervision profiles.
20. Agent identity is durable. A Runtime is temporary, exclusive-leased, fenced, and usually dormant when idle.
21. Safe failures are automatically re-attempted under the same Task; ambiguous side effects require reconciliation.
22. Builder workspaces belong to Tasks; code durability uses early pushed Git checkpoints and disposable worktrees.
23. Every Grove Site includes local execution by default and may enroll additional hosts using the same host implementation.
24. Host and model selection are resolved per Task under capability, policy, privacy, locality, and budget.
25. A2A is an optional boundary adapter, never Grove's internal object or workflow model.

## Superseded

1. **Separate Tracker product or authority.** Replaced by the Library Task module. Existing tracker adapters are migration seams only.
2. **Record as workflow, vertex, edge, receipt, provenance wrapper, or Library item.** Removed.
3. **Record graph as a second signed layer.** Replaced by signed immutable Versions and first-class typed objects.
4. **Separate Outcome object.** A completed Task is the outcome.
5. **Projects as a separate object hierarchy or global context switcher.** A Project is a Task role and a Library object page.
6. **Home / Rooms / Work / Library / Agents as mandatory top-level silos.** The participant shell is Home, Library, and contextual object pages; operations live in Admin.
7. **Ordinary Room speech mutating Task state.** Humans use explicit controls; agents use Task MCP operations.
8. **Every Matrix room receiving Grove Room semantics.**
9. **Every durable event becoming equally prominent in search and graph navigation.**
10. **Public blockchain consensus or mandatory public transparency logging.**
11. **A second participant application or backend invented beside the current unified console.**

## Deferred without blocking the first build

1. Exact durable workflow engine: Effect Workflow, embedded Postgres executor, Temporal, or another implementation.
2. Public Sigstore/Rekor use versus private Site signing and optional external transparency receipts.
3. Full federation and Project-home transfer UX.
4. Capacity federation between Grove Sites.
5. A2A gateway implementation.
6. Exact Topic/claim taxonomy and long-term Librarian heuristics.
7. Consumer/family product profiles beyond shared policy and host primitives.
8. Advanced graph visualization.
9. Full local-companion installer polish.
10. Exact retention defaults beyond policy-scoped retention.

## Non-negotiable migration constraints

- No dual Task writers.
- No destructive copy-over of old source trees.
- No secrets or runtime state in source history.
- No app-to-app source dependencies.
- No UI-only operation that bypasses the shared command plane.
- No unsigned accepted object Version.
- No Task completion based solely on an executor reporting success.
- No Room membership grant that silently expands data, tool, host, or Task authority.
