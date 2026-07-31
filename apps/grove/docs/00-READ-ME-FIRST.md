# Grove build handoff

**Prepared:** 2026-07-23  
**Audience:** Eli and implementation agents  
**Purpose:** Start building Grove without re-reading the 4,272-file source export or reconstructing decisions from chat.

## Load order

1. Read [`01-GROVE-BUILD-SPEC.md`](01-GROVE-BUILD-SPEC.md). It is the only normative product and architecture specification in this package.
2. Load one focused view only when the work requires it:
   - [`02-UX.md`](02-UX.md) for product flows, Rooms, Home, and human/agent interaction.
   - [`03-UI-AND-LIBRARY.md`](03-UI-AND-LIBRARY.md) for the visual system, Library experience, object pages, and accessibility.
   - [`04-TASK-DAG.md`](04-TASK-DAG.md) for Tasks, planning, Attempts, Claims, workflow actions, recovery, and completion.
   - [`05-ARCHITECTURE.md`](05-ARCHITECTURE.md) for the current monorepo, authority boundaries, deployment, and migration.
3. Fetch deeper evidence through [`context/CONTEXT-MAP.md`](context/CONTEXT-MAP.md) only if a claim needs provenance or code-level confirmation.

## Authority rule

`01-GROVE-BUILD-SPEC.md` wins over every other file in this zip.

The four focused documents are implementation views of that spec, not independent specifications. If a focused view appears to conflict with the master, follow the master and file a spec correction.

The historical `spec-package/`, exported transcripts, screenshots, and old console briefs are evidence, not authority. They contain superseded models.

## The rectification in one page

- Grove is one installed and operated service made of internally bounded parts.
- The Library is Grove's universal object graph, shared PKM, discovery layer, and durable data substrate.
- There is no separate Tracker product in the target model. Task authority is a bounded module inside the Library.
- A Project is a Task carrying the `project` role.
- Work is a directed acyclic graph of Tasks. Tasks may have arbitrarily deep child Tasks and explicit dependency edges.
- One Task may have many Attempts. One Attempt may use a durable workflow internally. Claims are temporary fenced leases.
- A Task completes only when its completion contract is satisfied and its verification policy accepts the result.
- Every durable object has a stable identity and immutable, content-addressed Versions with signatures and provenance.
- There is no `Record` domain object. This is the intentional **recordicide** decision.
- Approvals, reviews, comments, messages, Tasks, artifacts, and other meaningful facts are first-class versioned objects, not payloads wrapped in Records.
- Rooms are Task-anchored human-readable collaboration contexts. Conversation is free; official state changes require explicit Grove controls or agent MCP operations.
- Agents have durable identities; Runtimes are leased, fenced, movable, and normally dormant when idle.
- The current `console-monorepo-current-daca287a` is the implementation base. The design extends its unified SvelteKit/Effect console, Postgres Library tables, bus, command plane, and Rust fleet components.
- Migration preserves current Task lease/fence semantics and replaces the legacy task adapter without dual writers.

## First implementation target

Build one honest vertical slice before broad UI expansion:

```text
Private Ask/Capture
→ Project Task
→ planned Task DAG
→ claimed Attempt
→ agent execution
→ durable output Version
→ independent review
→ accepted completion
→ realm-safe contribution to the Grove Library
→ searchable and citable result
```

For code work, “accepted completion” includes the repository's required checks and merge to the configured target branch. For non-code work, the Task's completion contract defines the equivalent approval flow.

## Package layout

```text
GROVE-HANDOFF/
├── 00-READ-ME-FIRST.md
├── 01-GROVE-BUILD-SPEC.md
├── 02-UX.md
├── 03-UI-AND-LIBRARY.md
├── 04-TASK-DAG.md
├── 05-ARCHITECTURE.md
├── context/
│   ├── CONTEXT-MAP.md
│   ├── DECISION-REGISTER.md
│   ├── CURRENT-IMPLEMENTATION-EVIDENCE.md
│   └── audits/
│       └── 2026-07-23-grove-build-spec-audit-rounds.md
├── MANIFEST.sha256
└── PACKAGE-MANIFEST.txt
```

## Explicitly not included

- full chat transcripts;
- the original 55 MB export;
- runtime databases, credentials, crypto state, logs, or backups;
- old generated HTML mocks;
- superseded merge manifests;
- research corpora;
- duplicated console snapshots.

Those remain in the source workspace for provenance and can be fetched deliberately through the context map.

## Browser authentication deployment

Grove browser sessions use a dedicated confidential OIDC client through Authorization Code + PKCE.
Register this exact callback URL with the identity provider:

```text
${BETTER_AUTH_URL}/api/auth/callback/grove-oidc
```

Set `BETTER_AUTH_URL` to Grove's canonical public origin and configure
`GROVE_OIDC_ISSUER`, `GROVE_OIDC_CLIENT_ID`, `GROVE_OIDC_CLIENT_SECRET`, and
`BETTER_AUTH_SECRET` through the deployment secret manager. Production origins and issuers must use
HTTPS. Plain HTTP is accepted only for loopback development. Begin browser login at `/login`.

Email/password authentication is disabled. Grove also disables implicit account linking and requires
the OIDC provider to return a verified email before issuing a session. The browser OIDC client ID and
secret are never credentials for `/mcp`; MCP resource-server authorization has separate configuration.

## MCP authorization deployment

Grove's `/mcp` endpoint is a distinct OAuth 2.1 protected resource. Configure
`GROVE_MCP_ISSUER`, `GROVE_MCP_JWKS_URL`, and `GROVE_MCP_RESOURCE` separately from the browser OIDC
client. `GROVE_MCP_RESOURCE` is Grove's canonical public origin; the token audience is its `/mcp` URL.
Production values must use HTTPS.

Configure the separate authorization server to issue audience-restricted tokens with the `grove:mcp`
scope. This deployment chooses pre-registration: pre-register only approved MCP clients and disable or
restrict Dynamic Client Registration and Client ID Metadata Documents according to deployment policy.
MCP clients perform Authorization Code + PKCE against that authorization server. Grove is only the
protected resource and exposes no authorization, token, or client-registration endpoints.
Protected-resource metadata is published at `/.well-known/oauth-protected-resource/mcp`. Browser
session cookies do not authorize `/mcp`.
