# Point v1 — Build Plan

*Fable's working plan, 2026-07-11. Source of truth: `FABLE-BRIEF-point-v1.md`, `point-v1-spec.html`,
`point-rebuild-decisions.md` (the 18 locked decisions), `point-teardown.md`. This file tracks how the
build is executed; `DECISIONS.md` tracks every non-obvious call.*

## Repo home

**Point lives in `PetalNet/monorepo` at `apps/point`** (Parker-approved retarget, D-013).
Branch for the v1 build: `feat/point-v1`; PR into monorepo `main`; CI is
`.github/workflows/point.yml`. The old `PetalNet/point` repo is vestigial.

## Mission (one line)

Turn the seeded skeleton into **Point v1**: "Matrix for location" — open, self-hostable, MLS-E2E,
**fully federated in v1**, people-only, Android-first — clearing all 6 GO-bar items.

## Ground rules

- Feature branch per milestone/subsystem → PR → CI green → adversarial review (subagent) →
  container-tested real E2E path → self-merge. No facades; every milestone is verified by driving
  the actual flow (register → share → receive encrypted fix → decrypt; M3 across two instances).
- Crypto/authz/federation-trust changes are verified by me (the orchestrator) directly, never
  delegated as a subagent's final word.
- Non-obvious calls → `DECISIONS.md`. Real forks/blockers → `/home/docker/point-fable/BLOCKERS.md`.
- Shared host: prefer `cargo check` + targeted tests while iterating; stagger heavy builds.

## Milestones

### M0 · Foundation (branch `m0-foundation`)
Real axum + Postgres server in `server/`:
- **Auth**: local accounts — Argon2id, JWT HS256 (algorithm-pinned), 7-day expiry, revocation via
  `password_changed_at`. Optional OIDC behind an env flag, **off by default**. Honest boot: refuse
  to start without ≥32-char `JWT_SECRET`.
- **Schema** (sqlx migrations, Postgres): `entities` (person+item first-class; people-only impl),
  users/devices, MLS key packages (multi-KeyPackage from day one), share_requests → user_shares,
  temporary_shares (TTL/links), groups+roles, visibility modes, ghost state (server-enforced,
  persisted), ciphertext location blobs + history. **Ciphertext + routing metadata only.**
- **Authz**: fail-closed — deliver only on explicit current relationship, never when ghosted.
- **Transport**: REST (Bearer JWT) + WS (auth as first message, never in URL); ciphertext frames.
- **CI**: GitHub Actions — Rust build+test+clippy+fmt; Flutter analyze (activates in M1); server
  integration tests against a real Postgres service container.
- **Glitchtip**: wire DSN via env (sentry-compatible crate); if no DSN self-servable → BLOCKERS.md.
- **Verify**: containerized E2E — register two users, request/accept share, deliver an MLS-encrypted
  fix over WS, decrypt on the receiving side; prove the DB holds only ciphertext.

### M1 · Client rewrite (branch `m1-client`)
Flutter app in `app/` (Android-first), legacy internals rewritten:
- Typed services replacing the 1,303-line `LocationNotifier`: `LocationStateMachine`,
  `RelayService`, `SharingService`, `GhostService`, `PresenceService` (+ `CryptoService` over
  point-core via flutter_rust_bridge).
- **GO-bar #1**: `WidgetsBindingObserver` wired — lifecycle → background transitions actually call
  the battery-engine hooks; Android foreground service for background sharing.
- **GO-bar #6**: ghost on/off persisted locally + server-enforced.
- Multi-device ACCESS (view from any device; broadcast only from primary) + device-linking
  enrollment (QR/short-code; server never injects devices).
- Battery-engine design lifted from legacy (state machine sleeping→idle→active↔fast, accel gate,
  learned zones stay local-encrypted).
- **Verify**: instrumented Android test / emulator run proving fixes continue when backgrounded.

### M2 · Reliability — clears NO-GO (branch `m2-reliability`)
- **GO-bar #2**: MLS state durability — export_state after every mutation → secure storage;
  restore on boot (core support already exists and is tested; wire it through the client).
- **GO-bar #3**: durable WS outbound queue (persisted, survives restart) + reconnect with jittered
  backoff.
- **GO-bar #4**: reliable direct/temp sharing — multi-KeyPackage pool with server-side one-time
  consumption; no silent member drops.
- **Verify**: kill/restart mid-session tests; disconnect during fix stream loses nothing.

### M3 · Federation — fully v1 (branch `m3-federation`)
- Discovery: `id@domain` → `/.well-known/point` (+ SRV fallback) → S2S endpoint.
- Signed Ed25519 S2S inbox (lift legacy design: replay window, SSRF blocklist) carrying remote
  KeyPackage fetch + ciphertext relay.
- TOFU-pin of remote identity keys; pinned-key-change = loud warning + forced re-verify; optional
  SAS/QR verify → "verified" badge. Cross-instance share stays green native-E2E.
- **Verify (the honest test)**: two full server instances in containers, a user on each, live E2E
  share; assert both DBs contain only ciphertext and each side decrypts the other's fixes.

### M4 · Self-host / ship (branch `m4-ship`)
- ghcr images (server; app APK artifact), honest docker-compose (Postgres + server + Traefik
  labels), real docs: stand up AND federate as a stranger.
- Zero-knowledge recovery: recovery secret → encrypts identity/signing-key backup → server stores
  the blob it cannot read; restore flow on a fresh device.
- Multi-device access verified end-to-end. Glitchtip + observability confirmed.

## Toolchain notes
- Rust 1.96 present. Flutter SDK not installed — install user-local at M1 start.
- `gh` CLI installed to `~/.local/bin` for PR flow; push auth via the configured x-access-token
  remote (PAT never in commits/logs).
- Host is shared: build heavy things sequentially, `cargo check` first.
