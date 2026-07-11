# FABLE-BRIEF — N1.3: Matrix Channel Features (harness rewrite, Phase 1)

> **Node class: MERGE/HARDEN** — matrix-channel-rs is LIVE (E2EE via matrix-rust-sdk,
> single-owner lockout). This node finishes the post-cutover feature set: key-backup
> persist/reset hygiene, honest read receipts, poll RECEIVE, and E2E tests. No Parker gate
> (greenlit class in the DAG plan), but see "check-first" below.
>
> **Build weight: HEAVY — the heaviest Phase-1 node.** matrix-rust-sdk is a huge dep tree;
> a cold `cargo build` takes minutes and real RAM. The launcher must budget for this and
> should prefer warm incremental builds (`target/` exists at
> `/home/docker/matrix-channel-rs/target`). Cap parallelism hard.
>
> **Check first:** the 2026-07-09 overnight plan already scoped an N1.3 burn. Local git
> shows only `master` (4 commits, tip 9e2d360) — but before starting, `git -C
/home/docker/matrix-channel-rs branch -a && git log --oneline -5` and look for newer
> work; if a prior burn branch exists, continue it instead of forking a duplicate.

## §0 — How to work (fully autonomous, unattended, no human mid-run)

- You are **Fable**, running alone. Brief = source of truth. Pick-and-log free choices into
  `DECISIONS-N1.3.md` at the repo root of your branch; never block.
- Repo: `/home/docker/matrix-channel-rs`. New branch **`feat/N1.3-channel-features`** from
  `master`. Commit locally per phase; do NOT push; no PR.
- **REVIEWABLE-ONLY + the cardinal E2EE rule:** the LIVE channel process owns
  `matrix-owner.lock` and the crypto store. You MUST NOT run a second synced client against
  Janet's live account/crypto store — that is exactly the corruption the single-owner lock
  exists to prevent. All runtime testing happens against mock/fake transports or a
  throwaway account/homeserver IF one is already configured locally; otherwise tests stay
  at the unit/logic level and you note what needs a staging run. Never delete or "clean up"
  `matrix-owner.lock`, `rust-session.json`, recovery-key files, or any live store.
- **Build budget (RAM-tight shared host):** `CARGO_BUILD_JOBS=2`, `nice -n19 ionice -c3`,
  reuse the existing `target/`, prefer `cargo check`/`cargo test` cycles, ONE release build
  at the end. If load is high, wait. No nix builds (`flake.nix` exists; skip it — cargo
  only). No nixos-rebuild.
- GitHub does not resolve from this host; crates.io may not either. If `cargo` cannot fetch,
  work offline against the existing Cargo.lock + local registry cache (`--offline`) and log
  any feature you had to descope because it needed a new crate.

## Mission

Close task-586 (+498): make the channel's E2EE storage hygiene bulletproof (no key-backup
spam/regeneration loops — root of the 07-09 outage noise), make read receipts HONEST (a
receipt means "the drain hook actually surfaced this message to the agent", nothing else),
implement MSC3381 poll **receive** (start/response/end → spooled inbound events so Janet can
see votes), and pin the whole feature surface with E2E-style tests that run without a live
homeserver.

## LOCKED decisions (do not relitigate)

- **Single-owner lockout is load-bearing and stays exactly as designed**: first instance
  owns lock+crypto+sync; every other instance completes the MCP handshake but opens no
  crypto, runs no sync, and answers tools with a lockout message. Never remove a lock that
  might belong to a live owner — err toward lockout over takeover.
- The channel is the agent's ONLY Matrix identity surface; the manager↔channel ownership
  state is contract data (`channel_lock` in
  `/home/docker/janet-manager/docs/contracts/schemas/session-state.schema.json#/$defs/channelLock`
  — held | released | lockout). Expose the current lock state so the manager can publish it
  (a small status file or MCP tool; pick-and-log the mechanism).
- Honest receipts (task-498): receipt ⇔ message crossed the drain-hook spool boundary to
  the agent. No receipts on lockout instances, no backlog dumps when `read_receipts` was
  off, no receipt for messages filtered before surfacing.
- Inbound delivery stays via the spool (`src/channel/spool.rs`, `inbound-spool.jsonl`) —
  the existing drain-hook contract keeps working unchanged for old consumers.
- Recovery key persists at its configured path with 0600; `allow_identity_reset` remains a
  config-gated explicit action, never automatic.

## Read first (ground truth, all local)

- `src/matrix/e2ee.rs` — bootstrap: recover-from-secret-storage, cross-signing, backup
  restore-or-create (lines ~110–141), the WARNING path when a backup exists but no local
  recovery key. The key-backup spam lives here or in its callers: characterize it FIRST
  (when does re-boot re-enable/re-create backups? is `enable recovery` re-run per boot?).
- `src/matrix/handlers.rs` — inbound pipeline + the read-receipt-on-perceive watcher
  (~line 494+): seeded lastAckedSeq, `read_receipts` config gate, per-room CS-API receipt,
  retry window. This is what "honest" must be reconciled against.
- `src/channel/spool.rs` + `src/channel/mod.rs` — the spool that defines "surfaced".
- `src/matrix/send.rs` — MSC3381 poll SEND (start ~264, end ~303) — mirror its event shapes
  for receive; `src/matrix/raw.rs` for raw event plumbing.
- `src/owner.rs` — the lockout mechanism (pid:starttime lock; read its header).
- `src/mcp/mod.rs` — tool registration (where poll-receive/state tools land);
  `src/config.rs` — settings (read_receipts flag etc.); `MIGRATION.md` — deploy context.
- `/home/docker/janet-manager/docs/contracts/CONTRACTS.md` §2 (channel lock) — the contract
  this node must surface state for.

## Deliverables (branch `feat/N1.3-channel-features`, local commits only)

1. **Key-backup hygiene**: boot is idempotent — an existing healthy backup + stored
   recovery key ⇒ zero writes, zero re-enables, one log line. Backup creation happens only
   when none exists; identity reset only via `allow_identity_reset`. A regression test
   simulating the boot decision table (exists+key / exists+no-key / none / query-error).
2. **Honest read receipts**: receipts keyed to spool-surfaced events (ack pointer advances
   only past events the drain hook consumed); lockout instances send none; disabled →
   re-enabled never dumps a backlog. Decision table documented in code + DECISIONS.
3. **Poll receive**: handle `org.matrix.msc3381.poll.start/response/end` inbound (incl.
   encrypted), spool them as typed entries ({poll_id, question, answers, votes-so-far,
   ended}), aggregate responses per MSC3381 last-vote-wins. MCP tool to read current poll
   state. Send side already exists — do not touch its API.
4. **Channel-lock state surface**: expose held|released|lockout per the channelLock
   contract (mechanism pick-and-log: status file next to the heartbeat convention, or MCP
   tool, or both). No manager-side changes (that's N1.1's stub to wire later).
5. **E2E-style test suite** that runs WITHOUT a live homeserver (handler-level tests with
   synthetic timeline events; the matrix-rust-sdk test utils if already vendored). Every
   deliverable above gets at least one test.
6. `DECISIONS-N1.3.md` — findings (esp. the characterized backup-spam root cause), choices,
   §0 compliance, build/test log, staging-run checklist (what could NOT be proven offline).

## Phased order

1. Read ground truth; characterize the key-backup spam root cause from code + any local
   debug.log evidence (read-only); write findings; commit.
2. Key-backup hygiene + tests; commit.
3. Honest receipts + tests; commit.
4. Poll receive + MCP tool + tests; commit.
5. Lock-state surface + tests; commit.
6. Full `cargo test` + one capped release build; final DECISIONS + staging checklist; commit.

## Stack / constraints

Rust + matrix-rust-sdk (version pinned in Cargo.lock — do not bump it; a bump is a
different, heavier task), tokio. MCP stdio server in `src/mcp/`. No new heavy deps; offline
cargo if the registry is unreachable. The flake/crane nix packaging is out of scope.
