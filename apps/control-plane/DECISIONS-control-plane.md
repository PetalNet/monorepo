# Control-plane / manager brains — DECISIONS log

Fable (backend-fable), 2026-07-12, branch `feat/control-plane` (stacked on
`feat/dispatcher-core`). New node per the backend-build brief + fleet-manager-spec v2 §2
(the Manager's brains: token/credential authority, cost/rate governance, tracker
discipline) and DAG N2.2 ("Manager as control plane").

## Decisions

| #    | Decision                                                                                                                                                                                                                                                                                        | Rationale                                                                                                                                                                                                            |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CP1  | New app `apps/control-plane` — the FLEET brain is a separate deployable from the per-agent supervisor (`apps/manager`)                                                                                                                                                                          | the hierarchy is Janet → control plane → box agents → workers (spec §1); one control-plane instance governs many per-agent managers — merging them into one binary conflates a per-agent unit with a fleet singleton |
| CP2  | Path dependency on `apps/dispatcher` (lib) for the contract types (card/envelope), spool transport, and glitchtip client                                                                                                                                                                        | one source of truth for contract serde inside the monorepo; CI builds the app standalone and the path dep rides along with `--locked`                                                                                |
| CP3  | Vault = file-backed credential store (one JSON file per credential, 0600, atomic rename), behind a `CredStore` trait                                                                                                                                                                            | house precedent is 0600 plaintext creds files (`~/.claude/shared/janet-account.json`); the trait is the seam for a real Vaultwarden backend later                                                                    |
| CP4  | Agent tokens are stored in the vault verbatim (0600), minted as UUIDv4, rotated by REPLACING the record (old value kept as `previous` for one grace window)                                                                                                                                     | verify-only hashing would break re-issue ("handles Parker's creds so he never touches them" means the authority must be able to hand a token back); grace window = agents mid-rotation don't hard-fail               |
| CP5  | Matrix-token self-heal is split: the AUTHORITY half (detect stale, rotate in vault, refresh the creds file the manager reads) lives here; the manager-side hot-reload (re-read creds_path on 401) is a separate follow-up PR to apps/manager                                                    | manager's matrix.rs collapses sync errors to `Err(())` today — surfacing auth failures is manager plumbing with its own blast radius and review; the creds FILE is the existing contract boundary between the two    |
| CP6  | Governance is a pure decision engine: usage window per agent → traffic light (green <70%, yellow <90%, red ≥90% of budget) → action (None / Throttle / Downgrade one tier / Pause), downgrade fires BEFORE 429 (yellow), cascade = ≥N agents rate-limited in the window → FleetMode::Sequential | spec §2 verbatim ("tier-downgrade before 429, cascade detection"); pure functions with injected clocks are table-testable                                                                                            |
| CP7  | Model tiers ordered opus > sonnet > haiku; a downgrade writes intent as a `governance.action` envelope — the per-agent manager applies it via its EXISTING `model_override_path` mechanism                                                                                                      | the manager already supports model-override files; the control plane must not reach into another host's filesystem                                                                                                   |
| CP8  | Budget quota reclaim is lease-based: each agent's budget grant is a lease (granted_tokens, expires); unspent grant returns to the fleet pool at expiry                                                                                                                                          | spec §2 "lease-based quota reclaim"; mirrors the board's lease semantics — one idiom                                                                                                                                 |
| CP9  | Tracker discipline: an agent whose fleet-events say `working` for > grace (default 10 min) with NO active lease and no task_id on the event gets a `defer` nag card from sender `system:control-plane`; repeat violations escalate to a principal report, never to an interrupt                 | spec §2 "tracker-usage discipline enforcement" as data; nags must not become interrupt spam (LOCKED interrupt model)                                                                                                 |
| CP10 | Registry: capacity reports (`agent.capacity` envelopes) upsert {handle, provides[], free_slots, last_seen}; staleness > 90s ⇒ `suspect`, > 5 min ⇒ `down` (consumer-derived, mirroring fleet-event offline derivation); persisted in the control-plane's own SQLite                             | same derived-staleness idiom as the cockpit (CONTRACTS §3); SWIM gossip is a multi-box follow-up (collab doc gap #3)                                                                                                 |
| CP11 | Runtime v1 I/O mirrors the dispatcher: inbound envelope spool dir + outbound spool via the dispatcher's `SpoolTransport`; the doorman client replaces the spool at N1.4 integration behind the same seam                                                                                        | one transport idiom across the backend until doorman lands                                                                                                                                                           |
| CP12 | Config deny_unknown_fields, required = {db_path, vault_dir}; Glitchtip DSN optional (dispatcher's client)                                                                                                                                                                                       | manager-config convention                                                                                                                                                                                            |

## §0 compliance

Branch-only in the backend-fable monorepo clone; no live service/config/DB touched;
tests on temp dirs/DBs; build caps CARGO_BUILD_JOBS=2 + nice.

## Review round (2026-07-12): codex + adversarial findings, all fixed

Codex (Sol) P1s, all fixed with tests: grants lost on restart → re-grant whenever an agent
has no live lease (`has_live_grant`); phantom Haiku→Sonnet "upgrade" → tier is self-reported
in usage.report, never assumed; discipline trusted the event's own task_id as lease state →
real tracker lease lookup (`tracker_db_path`; pass disabled without it) + working-grace timer
keyed on the observed status transition, not session start; vault filename `:`→`__` collided
with legitimate underscores → injective `:`→`+`; cascade fleet mode only logged → applied as
edge-triggered `fleet.mode` events on engage AND release.

Adversarial review, all fixed:
| Finding | Fix |
|---|---|
| MAJOR: non-canonical `envelope.agent` in usage.report poisoned governance and crashed the loop via SpoolTransport's handle rejection (DoS) | canonical-handle gate at the top of handle_envelope; governance_pass logs-and-continues per agent instead of `?`-aborting. Verified: a hostile line is refused to `.failed` and the daemon survives |
| MAJOR: governance was one-way — a downgraded/paused agent was never told to recover, and yellow↔green oscillation ratcheted the tier down forever | recovery is an edge: non-None→None emits a `restore` action; the emitted-downgrade self-mutation of `tiers` was removed (tier comes only from the agent's self-report) |
| MAJOR: envelope identity self-asserted; TokenAuthority dead code | documented as the doorman-deferred trust boundary (CP11/N1.4) at the construction site and the ingest gate; blast radius bounded by the canonical-handle gate |
| MINOR: unbounded grant map | `prune_expired` each governance tick |
| MINOR: ingest `.done`/`.working` files accumulated | `.working` deleted after processing; only rare `.failed` kept for triage |
| MINOR: future rate-limit epoch counted as "recent" forever | `age >= 0` clamp in fleet_mode |
| MINOR: vault tmp file briefly umask-readable before chmod | temp file opened `mode(0o600)` up front |

Residual (accepted): per-agent in-memory maps (usages/tiers/nagged/status_since) and the
SQLite capacity table key on agent handle and aren't swept for long-dead agents; with the
canonical-handle gate the key space is the bounded real fleet, and eviction of down agents
is follow-up hygiene. Daemon glue (handle_envelope/governance_pass) has no in-proc test yet
— the decision logic under it is unit-tested; the DoS + recovery paths were verified by
driving the real binary.
