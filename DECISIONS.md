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
