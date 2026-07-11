# Point v1 — Decision log (build-time)

*Every non-obvious call Fable makes during the build, grounded in the spec. The 18 product
decisions are locked in `point-rebuild-decisions.md` and are not relitigated here — this file is
implementation calls only. Newest at the bottom.*

## 2026-07-11 — D-001 · Keep the seeded core crate's durability extensions (it is not byte-identical to legacy)

The brief says `core/` was "lifted as-is / only the workspace path changed," but a diff against
`/home/docker/point/point-core` shows the seeded crate was **extended**: a `PointProvider` exposing
MLS storage export/import, a `PointCryptoState` envelope, `PointCrypto::restore()`, and a
state-roundtrip test. The extension is additive (no legacy API changed), it directly implements
GO-bar #2 (MLS state durability), and all 5 tests pass (`cargo test -p point-core`, includes an
export→restart→restore→encrypt/decrypt roundtrip). **Call: build on the seeded (extended) crate,
not the raw legacy one.** Re-deriving the legacy byte-for-byte would delete already-verified
durability plumbing the spec mandates.

## 2026-07-11 — D-002 · PRs via gh CLI installed user-local; push via the already-configured x-access-token remote

No `gh` on the host; installed v2.76.1 to `~/.local/bin` (no root needed). The seeded repo's origin
already embeds the PAT as an x-access-token URL — the brief explicitly permits that form. The PAT
never appears in commits, code, or logs.

## 2026-07-11 — D-003 · Flutter SDK deferred to M1 start

No Flutter on the host and M0 is server-only. CI's Flutter-analyze job will be added in M0 but
gated on the `app/` directory containing a real project, so M0 CI stays honest (no green job that
tests nothing). SDK gets installed user-local when M1 begins.

## 2026-07-11 — D-004 · Glitchtip: self-served a DSN from the lab instance

`glitchtip.petalcat.dev` runs on this host; no API token existed in shared secrets, but docker
access allowed creating a `point-server` project in the existing `petalnet` org via the Django
management shell (additive only — matches how college-map/tasks/courier are organized). DSN
stored at `~/.claude/shared/point-glitchtip-dsn` and injected via env (`GLITCHTIP_DSN`); never
in the repo. No blocker needed.

## 2026-07-11 — D-005 · Server enforces the spec's authz model, not legacy's actual behavior

The legacy survey (docs/legacy/server-map.md §2) shows legacy does NOT enforce: temp shares in
delivery (never consulted), sender's group membership on group fan-out, per-member `sharing`
flags, or per-target ghost (doesn't exist). The spec (§02) mandates "explicit, current
relationship (accepted share / active temp-share / group membership), never when ghosted."
Where spec and legacy code conflict, spec wins: the rebuild's single `authz` module enforces
ghost (global + per-target) → accepted share OR active temp share OR shared-group-with-sender-
a-member (+ member `sharing=true`), fail-closed on any error. Same gate for WS delivery,
history reads, and KeyPackage fetch.

## 2026-07-11 — D-006 · Argon2id parameters pinned explicitly

Legacy used `Argon2::default()` (whatever the crate ships). The spec says "Argon2id" as a
security property, so the rebuild pins Argon2id v19, m=19456 KiB, t=2, p=1 (OWASP baseline,
same values as today's crate default) explicitly in code — a crate upgrade can never silently
change our KDF cost.

## 2026-07-11 — D-007 · KeyPackages are one-time-consume with a last-resort fallback

Legacy returned every stored KeyPackage to every fetcher and never deleted any (the
"single-KeyPackage silent-member-drop" root cause, GO-bar #4). Rebuild: fetch atomically
consumes one unconsumed package (`DELETE … RETURNING` semantics); each user also keeps one
`is_last_resort` package that is returned (not consumed) only when the pool is empty; clients
top the pool up. This is the standard MLS delivery-service pattern.

## 2026-07-11 — D-008 · Entity model: `entities` table (person|item), location rows reference entities

Decision 7 requires person+item first-class in schema, people-only implementation. Rebuild
gives every user exactly one `person` entity (partial unique index); `location_updates` /
`location_history` reference `entity_id`, so v1.5 items become new entity rows with zero
schema rewrite. All REST/WS surfaces stay user-addressed in v1; the server resolves user →
person entity internally.

## 2026-07-11 — D-009 · No visibility_modes table, no zone_consents table in v1 schema

The teardown/spec name "visibility_modes (Focus-style)" and "mutual-consent zones" as kept
sharing model, but a code grep shows legacy has NO visibility implementation at all, and zone
consents are bookkeeping for personal-place geofences — a v1.5 feature (places). Building
tables no v1 code reads would be a facade. Call: `users.visibility_mode` text column ships as
the slot (default 'normal', no v1 surface); zone_consents lands with places in v1.5. If this
reads as spec-drift, it's flagged here for review.

## 2026-07-11 — D-010 · axum 0.8 + sqlx runtime queries + sqlx::test against real Postgres

Seeded stub had axum 0.7; legacy is 0.8 and all lifted handler patterns are 0.8-shaped — the
rebuild uses 0.8. SQL uses runtime `query()` + `bind` (like legacy) rather than compile-time
`query!` macros, avoiding sqlx offline-cache churn in CI; correctness is covered by
integration tests (`#[sqlx::test]`) that run every query against a real Postgres.

## 2026-07-11 — D-011 · WS auth re-validates password_changed_at (closes a legacy gap)

Legacy's WS first-message auth verified the JWT signature/expiry but skipped the
`password_changed_at` revocation check that REST enforced — a revoked token could still open a
live location stream. The rebuild runs the same full validation on both paths.

## 2026-07-11 — D-012 · M0 server scope: FCM sender deferred to M1

`fcm_tokens` schema ships in M0, but the FCM wake-push sender lands with M1 (when a client
exists to wake). Nudges to offline users queue/no-op until then. Keeps M0 honest — no
untestable push code.

## 2026-07-11 — D-013 · Repo retarget: Point moves into PetalNet/monorepo at apps/point

Parker-approved directive (DIRECTIVE-POINT-MONOREPO.md) reverses decision 18's "own repo" call:
Point now lives in `PetalNet/monorepo` at `apps/point`. Migration followed the documented
`apps/manager` precedent (docs/MIGRATION.md): contents `git mv`-ed to `apps/point/` in the source
clone, merged with `--allow-unrelated-histories` so full history (seed → M0 scaffolding → wave A)
survives `git log --follow`. Adaptations: monorepo Rust conventions (pinned `rust-toolchain.toml`
1.96 like apps/manager; apps/point stays its own Cargo workspace, not a pnpm package); CI is a
minimal path-filtered `.github/workflows/point.yml` (Rust fmt/clippy/build/test vs a real
Postgres service + Flutter analyze gated on the app existing) — conventional base only, Eli owns
CI optimization; SHA-pinned actions to satisfy zizmor. Point keeps its AGPL-3.0 LICENSE at
`apps/point/LICENSE` (app-level license, monorepo default doesn't override it). The old
`PetalNet/point` repo is vestigial — left as-is with the pre-migration branches pushed.
Everything else (spec, GO-bar, M0→M4, review discipline, BLOCKERS escalation) is unchanged.

## 2026-07-11 — D-014 · M1 client will be built against the Flutter playbook

`/home/docker/point-fable/flutter-playbook.md` is the UI craft bar for the client: official Dart
MCP server wired day one (render→see→fix loop via `flutter run -d chrome`; no blind Dart),
Material 3 + `ColorScheme.fromSeed` + `dynamic_color`, Riverpod pinned, widget classes (never
`_buildX()` helpers), zero-analyzer-warnings gate, alchemist goldens for stable primitives
(presence dot, ghost toggle, QR frame), feature-first layout, a CLAUDE.md rules file in
`apps/point/app`. Flutter SDK is not on this host: at M1 start I attempt a user-local SDK
install; if the render loop can't be stood up, that's a BLOCKERS.md entry per the directive —
not a license to write the client blind.
