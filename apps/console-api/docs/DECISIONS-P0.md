# DECISIONS — P0 contract surface (board rounds)

_console-backend Fable · 2026-07-12 · per-node review record (pattern: DECISIONS-N1.3)._

## Board round 1 — draft 324d963

Six reviewers on the P0 draft: five personas (backend architect, security, frontend-consumer,
ops/SRE, data/graphing fidelity — all independent sub-agent reviews) + codex (gpt-5.6-terra,
adversarial, read-only). Verdicts: architect REVISE · frontend REVISE · codex REVISE ·
security APPROVE-WITH-FIXES · ops APPROVE-WITH-FIXES · data APPROVE-WITH-FIXES.
~80 deduped findings; every HIGH/P0 accepted and applied. The classes and their resolutions:

### Authorization (security H1/H2, codex P0-1/2, architect H5)
- **Per-op `authz` descriptor** added to every ops.json entry (`rule: own|grant|own_or_grant|
  read`, relation, `scope_any` templates); router authorizes lane ∩ target-grant BEFORE the
  intent audit. Lane vocabulary closed (5 lanes); owner-gating expressed as grant relations,
  not a phantom lane.
- **Emit-authz matrix** (§4.3): producer registrations bind source identity; reserved
  namespaces; scope-ownership; per-producer severity caps, rate + new-type registration caps
  (quarantine → curation proposal). /emit can no longer forge audit/attention/p0 or poison
  the registry.
- SQL mode moved off `viewer` (operator+); `security_invoker=on` mandated on every lake view;
  no dblink/fdw (Phase 1 acceptance); SET/search_path pinned; the read-only ROLE named as the
  control.
- forwardAuth: dedicated middleware + assist-parity header checks; **`:80 trustedIPs` closure
  = hard precondition**. Principal.kind bound at auth path; token revocation per-request;
  principal propagated as a verifiable assertion across executor hops.

### Op lifecycle + audit honesty (codex P0-4, architect H3, security M6)
- **Two-phase audit**: `audit.op.intent` (outcome: attempted) before dispatch;
  `audit.op.outcome` (ok|failed|executor_died) on completion, linked by op id. Executor death
  renders attempted-without-completion, never "ran".
- **`status: accepted|applied`** on op-result (spool/RPC executors are async; accepted ≠
  success; completion closes via the op's emits[] carrying the op id). `agent.command`
  envelope id = op id verbatim (N0.1 dedup composes; no double-restart).
- Dedup window ≥24h; duplicate (principal,id) replays the recorded result; `id_reused` on
  body mismatch. Read ops skip audit (3 null-audit_seq cases enumerated). `dry_run` added.
- Lease preconditions on task.update/close (`lease: {fence, claim_token}` for agents;
  `force` for human principals, audited) — the N0.1 fence rule preserved end-to-end.

### Bus soundness (architect H4, codex P0-5, ops H3, security M4)
- Serialized appender; fan-out after commit in seq order; `since` exclusive; subscribe ack
  with `replay_through_seq`; bounded queues + gap frames; retention → resync_required;
  re-fence on grant change. All in `bus-frame.schema.json` (new, normative).

### Bridges (codex P0-6, ops H4/H5/M2, architect M4/M5/L7)
- Per-box bridge processes POSTing /emit; deterministic UUIDv5 ids + durable cursors;
  per-source delivery guarantees tabled in §4.4 (snapshot lossiness documented; dispatcher =
  read-only poll per DP2); gap_detected/cursor_reset/source-unreachable emissions; producers
  spool-and-retry same id on /emit failure; Matrix warning path retired only after
  lake.disk.watermark proves itself.

### The contract actually pinned (codex P0-8/9, architect H1/H2/H6, frontend H1-H5)
- **`schemas/entities/` shipped** — 20 schemas, field lists verified against as-built code
  (corrections: dispatcher cards `result` column; full tracker column set incl. capability/
  owner_machine/responsible; collector DDL at /home/docker/update-collector; governance
  0=never→null). Read-envelope + pagination contracted.
- ops.json: JSON-Schema args, op-catalog.schema.json governs it, CANONICAL (prose table
  generated, CI-checked); `research`→`kb.research`; spec_name_aliases table; missing ops
  added (delivery.resend, dashboard.delete/share); service.stop confirm typed-name; testable
  field (disposable|dry-run-only|live-canary; fleet.mode = live-canary + runbook).
- New reads: `/me`, `/executors`, `/roster`, `/health`, `/box-updates/{id}/raw`.
- Comms emission mapping pinned (comms.card|rpc|mail dimensions + body_ref); digest model
  (subscription.window, server-assembled, next_digest_at, cocoon_until); attention rules
  enumerated in-schema with pre-bound fix_ops args.
- **additionalProperties: true on all server→client shapes** + consumers-ignore-unknown
  (restores N0.1's evolution qualifier; Phase 2/5 additive changes no longer break pinned
  validators). Mode-discriminated query-request; oneOf op-result; type-conditional PanelSpec.

### Statistic-contract fidelity (data H1/H2, M1-M5)
- Per-field typing `meta.fields` (unit/kind gauge|counter|delta|timestamp/cardinality) —
  aggregation honesty validated at query time (agg_mismatch).
- Edges baked at ingest: subject_kind + links[] on the emission; edge storage Phase 1;
  GET /graph reserved (Phase 2). Registered views = the join mechanism; time.fill + coverage
  (honest uptime); PanelSpec regains color_palette + enum forecast.confidence; top-level
  suggestions; branch block on dashboard.save; SelectedMark-complete context.receive.

### Ops/physics (ops H1/H2/H6/H7, M5/M6)
- TimescaleDB pinned (real rollup mechanism; lake:rollup freshness source); volume budget
  0.2-0.3M rows/day as acceptance gate (heartbeats NEVER bridged 1:1 at 1s); disk/volume
  decision = hard precondition; retention classes contractual (audit ≥1y); /health with
  bridge lag map; anti-recursion + sampling on self-instrumentation; dry_run for
  untestable-on-disposables ops.

### Explicitly NOT adopted
- OpenFGA/SpiceDB (lean tuples stand, per /task/724 research).
- Multi-instance bus / LISTEN-NOTIFY now (single-writer stated; escape hatch documented).
- Per-subscriber seq counters (global seq_head disclosure accepted at lab scale — noted in
  bus-frame schema; revisit if the console leaves the LAN).
- `*.propose` op variants (server-side transformation for propose_only tiers instead —
  stable response shape, no catalog doubling).

## Board round 2 — revised text

Four re-reviews of the revision: architect, security, frontend-consumer, codex. Verdicts:
**4× APPROVE-WITH-FIXES, 0 REVISE, 0 remaining P0/HIGH after fixes below.** Architect
mechanically verified all six round-1 HIGHs genuinely resolved (op names, catalog validation,
authz completeness, $ref resolution, schema compilation).

Round-2 fixes applied (same commit):
- **Template resolvability** (codex P1, security H1, architect M2): `${target.*}` resolution
  order documented + CI rule; task.* → `project:${target.project_id}`; dashboard.delete →
  `user:${target.owner}`; library.item.create → `${item.scope}`; curation.approve/reject →
  `item:${target.item_id}`; unresolvable scope_any ENTRY skips (all-unresolvable fails
  closed); absent task.dispatch recipient = pool card via the fleet entry.
- **emits[] forgery closed** (security H2, architect M4): §4.3 rule 6 — producer
  registrations carry default-deny type-prefix allowlists; any catalog `emits[]` type is
  accepted only from that op's gating executor's registration.
- **claim_token persistence** (security H3): dedup-recorded task.claim result stored
  scrubbed (replay = leasePublic); `task.claimed` emission = leasePublic only; task.claim
  results on the self-instrumentation never-capture list (Rule 6 updated).
- **New authz rules** (security M1/M2): `scope_visible` for attention mutations; `self` for
  signal.snooze/delivery.*/context.receive; window.arrange → own_or_grant editor on the
  dashboard item; card.repost/park least-privilege via `agent:${target.recipient}`;
  term stream ops bound to the opening principal; kb.research lane editor+; delivery.resend
  receipt must be caller-scoped; service.logs results scrubbed; delivery-time grant
  re-check on digests/interrupts (§4.2).
- **Catalog schema hardening** (codex P1): grant/own_or_grant require relation +
  nonempty scope_any (if/then); args must carry type|$ref + CI metaschema validation.
- **Schemas added/typed** (codex P1/P2, architect M3): emit-ack + health schemas; bus ack.error
  constrained to the error object; gap.reason required; read-envelope `truncated` + items
  composition note.
- **Frontend M1-M5**: roster per-source freshness (fleet_updated_at, started_at,
  registry_last_seen_epoch); heartbeat/governance `rate_limit_reset_epoch`; attention
  `blast_radius` object (pre-joined); task `project_title`; build-failed added to attention
  rules with pre-bound task.dispatch retry fix_op; comms dims + `card_id`; delivery.receipt
  dims pinned; `GET /tiers` (Phase 4); digest count-drift note.
- **Doc consistency** (architect M1/L5-L10): namespace count 27; Rule 1 emission dual-role
  exemption; retention-miss dual handling explained; alias notation defined; executor list
  aligned; P0-PLAN risk 6 rephased; handle patterns + post-normalization confirm compare;
  principal lanes description; op:<ns> grant object marked reserved; admin/term-lane denials
  in audit-class retention; query_ref dereference-as-caller pinned.

**P0 gate: PASSED.** Contract published to the frontend on merge.
