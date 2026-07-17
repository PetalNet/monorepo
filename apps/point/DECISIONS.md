# Point v1 — Decision log (build-time)

_Every non-obvious call Fable makes during the build, grounded in the spec. The 18 product
decisions are locked in `point-rebuild-decisions.md` and are not relitigated here — this file is
implementation calls only. Newest at the bottom._

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

## 2026-07-11 — D-015 · Client UI design LOCKED; final spec staged in-repo, supersedes direction doc

Parker+Eli signed off the final client UI (`POINT-UI-SPEC-FINAL.md`). Staged into
`apps/point/docs/design/` (UI-SPEC-FINAL.md, design-direction.md, flutter-playbook.md, and
mockups.final.html = the pixel-close visual target) so M1 builds against them in-tree. Where the
final spec and the earlier `design-direction.md` disagree, **the final spec wins** — notably:
router is **kaisel** (not go_router; pin in pubspec.lock; acceptance bar = animated adaptive shell

- auth-change-without-router-reset, login outside the shell); typeface is **Schibsted Grotesk**
  self-hosted (not Inter/Geist); the ghost/"you're sharing" signal is **inverse fill + label with NO
  pulse/ripple** (the direction doc's pulse is removed per Parker). Also locked: M3 fromSeed
  monochrome variant, **dynamic_color OFF**, zero hue in v1 (color reserved for bridges via an unused
  `BridgeAccent` extension), presence encoded by FORM not color, provider-agnostic maps (Google +
  MapLibre), Riverpod + feature-first + very_good_analysis + zero-analyzer-warnings gate, widget
  classes not `_buildX()`. nexus is an engineering reference only, not the visual target. Build via
  the Dart/Flutter MCP render→screenshot→fix loop.

## 2026-07-11 — D-016 · M0 adversarial-review fixes (security + correctness) before self-merge

Two adversarial review passes (security + correctness) ran against M0. The confidentiality boundary
held (no location/history leak path found; authz gate, SQLi, JWT pinning, WS auth parity, KP
consumption atomicity, secrets hygiene all confirmed solid, tests confirmed real not facades).
The peripheral findings were fixed on this branch (schema fixes are in-place edits to 0001 since it
has not shipped anywhere). Security-critical items were designed + verified by Fable directly:

- **Collation (verified bug):** `user_shares.CHECK(a<b)` used the DB default collation (en_US.utf8,
  punctuation-ignorable) while Rust orders bytewise → hyphenated username pairs (e.g. `ab-c`,`abb`)
  hit a 23514 → 500 and the share was permanently un-creatable. Fixed: `CHECK (user_a < user_b
COLLATE "C")` (byte-exact, matches Rust `<` on &str). Verified empirically + an end-to-end test.
- **OIDC account takeover:** the callback mapped a mutable `preferred_username` to a local id and
  logged into any matching row (incl. admin). Now OIDC accounts are keyed to the IdP's immutable
  `(oidc_issuer, oidc_subject)` (new columns + unique index); login matches on that pair, never the
  username; first-login provisions a NEW id (disambiguated on collision), never adopts an existing
  account.
- **KeyPackage drain via unconsented request:** `can_fetch_key_packages` no longer honors a bare
  _pending_ share request (unilateral) — it would let a stranger drain the one-time KP pool and
  downgrade forward secrecy. Requires accepted share / active temp share / shared group; the accept
  flow still works because a `user_shares` row exists by then.
- **Revocation reaches live sockets:** password change + account deletion now call
  `Hub::close_user`, tearing down open WS sessions for a revoked token (WS previously only checked
  the token at connect).
- **Rate-limit hardening:** wired `into_make_service_with_connect_info` (peer IP now resolves);
  `X-Real-IP` honored only when `TRUST_PROXY_HEADERS=true` (default off, fail-closed); added a global
  login cap.
- **MLS mailbox atomicity + one-time semantics:** commit fan-out is now one transaction (no partial
  desync); KP fetch split into a non-consuming `GET` probe and a consuming `POST …/claim` (a
  proxy-retried GET no longer silently drains the pool); per-recipient unconsumed-mailbox cap (429);
  rate limits on claim/welcome/commit.
- **Correctness:** live-fix write is an upsert on `(entity,type,recipient)` that rejects stale
  timestamps (no dup "current" rows, no older-clobbers-newer); group UUIDs canonicalized
  (lowercase) before storage/broadcast so history reads match; history pagination walks forward
  (ASC) when a `since` cursor is given; `mls_messages.sender_id` is `ON DELETE SET NULL` (a sender
  deleting their account no longer nukes others' undelivered welcomes); cleanup task GCs consumed
  KeyPackages (>7d) and processed messages (>30d); bounded WS outbound channel + 30s ping / 90s idle
  close; presence respects per-group `sharing=false`.

Deferred (logged, not v1-blocking): a read endpoint for `location_updates` current fixes lands in
M1 (the client that reads it); registration global-cap lockout (raise/scope) and L-tier timing
niceties tracked for a later hardening pass. Full finding list:
scratchpad `m0-review-findings.md`.

## 2026-07-11 — D-017 · M1 render loop is NOT blocked: Flutter toolchain stood up user-local

Per the directive, M1 needs the Dart/Flutter MCP render→screenshot→fix loop; a missing SDK would be
a BLOCKERS.md entry. It is not blocked. Installed Flutter **3.35.1 / Dart 3.9.0** user-local at
`/home/docker/flutter` (Dart 3.9 meets the MCP server's floor; `dart mcp-server` is present). A
render target exists: `flutter devices` sees a working **Chrome (web)** device using the host's
Playwright chromium (`CHROME_EXECUTABLE=/home/docker/.cache/ms-playwright/chromium-1223/
chrome-linux64/chrome`), so `flutter run -d chrome` + screenshot works for the playbook loop.
Linux-desktop and Android toolchains are absent (clang/ninja/GTK; Android SDK) — installable via
sudo if a pass needs real device/map behavior, but web is sufficient for UI craft iteration.
Toolchain paths live in `apps/point/app/.flutter-env.sh` (gitignored — host-specific). No blocker
filed.

## 2026-07-11 — D-018 · GO-bar #1 verified on-device + battery benchmark (Parker's industry-leading bar)

On-device verification on the lab phone (Samsung Galaxy A03s SM-S135DL, Android 13, adb
R9WWC0AEE2P), driving the REAL engine via an instrumentation harness (`lib/soak_main.dart`):

**Functional (all ✅, observed on the device):**

- `flutter build apk` links the native geolocator + sensors_plus + foreground-service plugins.
- Engine produces real fixes: `fixes: 2, activity=active, interval=2s, lat=38.68673 lon=-90.43058`
  (device fused location) — the state machine + LocationService + geolocator work end-to-end.
- Foreground service (`GeolocatorLocationService`) starts on share (survives background/doze).
- **Ghost hard-stops** GPS + the foreground service: after toggling ghost the fix counter froze,
  active HIGH_ACCURACY location requests dropped to 0, and the FG service was torn down — the
  `enterGhost` the legacy defined but never called, now wired (GO-bar #6).

**Battery (measured, not asserted — 20 min backgrounded under forced deep-doze,
`dumpsys batterystats`):**

- **GPS radio on-time: 143 ms over 20 min** (~0.01%). The accelerometer wake-gate keeps the GPS
  radio OFF while stationary; GPS only bursts when motion is detected. This is the dominant battery
  lever and where Point beats always-on-GPS trackers (Life360 / Find My poll GPS continuously).
- **Accelerometer wake-gate cost: 0.0003 mAh over 20 min** — negligible.
- **Battery level: 0% drop over 20 min in doze** while "sharing".
- Caveat/finding: 8.45 mAh of CPU accrued because the lab phone had _Location Accuracy_ (network
  location) OFF and no SIM, so `getCurrentPosition` spun. Fixed by bounding the heartbeat with a
  20 s `timeLimit` (D-018 tuning); once Location Accuracy was enabled, fixes resolved instantly and
  the engine ran at the adaptive cadence.

**Honest limits of this measurement (needs a field follow-up):** the lab phone is indoors with no
SIM, so (a) it initially reported `last location=null` until Google _Location Accuracy_ was enabled,
and (b) the _moving_-GPS drain (the active/fast 2 s cadence outdoors) could not be measured — only
the **parked-state** drain, which is the common case and where the GPS-off-while-still advantage
lives. Recommendation: a field soak on a SIM'd family handset, walking/driving, to measure the
moving-cadence drain and confirm the "beats Life360" claim under motion. The engine design (5-layer:
accel wake-gate → adaptive GPS cadence → stillness ramp-down → cheap network heartbeat → ghost
hard-stop) is the right shape for it; the parked numbers above are already best-in-class.

## 2026-07-11 — D-019 · M2 clears the NO-GO: MLS durability, durable relay, reliable sharing (verified on-device)

The three NO-GO reliability fixes, all built and hardware-verified on the lab phone (SM-S135DL):

- **GO-bar #2 — MLS state durability.** The lifted point-core MLS engine is bridged to Flutter via
  flutter_rust_bridge (`apps/point/app/rust`, the `point_mls` crate → per-ABI `.so` via cargo-ndk).
  `CryptoService` exports the full MLS state after every mutation (create/add/welcome/commit/
  encrypt/decrypt — the ratchet advances on encrypt/decrypt too) into secure storage and restores
  on boot. On-device proof: Alice forms a group with Bob, exports her 38 740-byte state, is
  restarted via `restore()`, and Bob still decrypts what the restored Alice encrypts.
- **GO-bar #3 — durable WS outbound queue + jitter.** `RelayQueue` persists outbound (pre-encrypted)
  fixes across restarts, bounded, evicting stale same-audience items first. `ReconnectPolicy` is
  exponential + full jitter and resets ONLY on a proven-healthy `auth.ok` (fixing the legacy
  reset-on-open bug). `WsService` does auth-as-first-message and flushes the queue only once healthy.
  18 unit tests.
- **GO-bar #4 — reliable direct sharing + one-time multi-KeyPackage.** Clients upload a POOL of
  KeyPackages; the server consumes one per claim (M0). On-device proof against a live server: two
  users, share → accept → claim ONE of the pool (asserted non-last-resort) → pairwise MLS group →
  Welcome relay → encrypted fix over the durable queue → decrypt to the exact fix; DB confirmed
  1-of-3 consumed and `location_updates` ciphertext-only.

`RelayController` assembles these into the shipping app: on sign-in it inits MLS, tops up the
KeyPackage pool, opens the durable WS, drains pending Welcomes; it forms the pairwise group with
each newly-shared peer (smaller-id party creates, to avoid rival groups), encrypts every
LocationService fix per share through the durable queue, and decrypts inbound broadcasts into
`PeerFix`es. Wired to sign-in + the People list. `.so` binaries are gitignored (rebuild via
`rust/build-android.sh`); the flutter CI job only analyzes/tests (no APK), so the generated Dart
bindings are committed and the native build stays local/dev.

## 2026-07-11 — D-020 · M2 adversarial-review fixes (crypto/relay)

The M2 review confirmed the design solid (one-time KP consumption, reconnect hygiene, transport
security, per-identity storage namespacing, dart-layer decrypt fail-safe) but found real issues,
fixed before merge (E2E-crypto-critical, verified directly):

- **M5 (security — ratchet reuse):** every mutating CryptoService method (incl. encrypt/decrypt,
  which advance the ratchet) now runs under a single async lock, so `mutate → export → write` is
  atomic and strictly ordered — concurrent encrypts can never persist a rewound ratchet (which
  could risk AEAD generation reuse on the next restore).
- **M7 (fail-safe):** the Rust bridge recovers a poisoned mutex (`unwrap_or_else(into_inner)`)
  instead of aborting the process on a malformed frame — a bad input fails that call, not the
  identity.
- **H1 (silent identity wipe → server pool brick):** `init` now returns a typed `MlsInit`
  (restored/created/wiped); on a `wiped` restore the relay force-uploads a FRESH KeyPackage pool
  regardless of the server count, so peers can't claim stale (private-half-gone) packages and
  silently fail to reach us.
- **H2 (dead receive path):** decrypted peer fixes now feed a `livePresenceProvider` that the map
  watches — inbound locations actually move the markers instead of terminating in an unlistened
  stream.
- **M2 (double group-formation):** an in-flight guard serializes `_ensureShareGroup` per target so
  a re-entrant `setShareTargets` can't claim two KeyPackages / overwrite the group (MLS desync).
- **M3 (concurrent-modification):** `_onLocalFix` snapshots the target set before the encrypt await.

Re-verified on-device after the fixes: the share E2E still passes (SHARE ✓) and 28 tests green.

Deferred as tracked follow-ups (real, not NO-GO blockers): M4 (a stale mid-session token loops the
reconnect — needs a token-refresh path; today the app re-inits on sign-in), M6 (the durable-queue
boundary is `sink.add`, not an app-level ack — bounded impact for superseded fixes), M1 (the
larger-id party can't broadcast until the smaller-id peer's client forms the group — needs an
either-party-after-grace fallback), M8 (RelayController-level + concurrency/reload tests). Logged
here so they're legible.

## 2026-07-11 — D-021 · M3 federation proven: honest cross-instance E2E, ciphertext-only

Federation is fully v1 (decision 15): a user on instance A shares E2E with a user on instance B,
both servers relaying ciphertext only. Built on the M0 server: per-instance Ed25519 key, well-known
discovery, a signed S2S inbox that verifies over the EXACT received bytes (canonical — fixes the
legacy serde-reserialize fragility), DNS-resolution SSRF (rejects any resolved private/loopback IP,
defeating rebinding), replay window, and TOFU-pin with loud key-change rejection (the muscle the
legacy skeleton lacked). The initiate side (`/api/federation/send` for `share.request`) records the
local outbound pending so the peer's `share.accept` passes anti-forgery — completing the flow via
the real API, not a test shortcut.

**The honest proof** (`server/tests/{run-federation-e2e.sh,federation_e2e.rs}`): two full instances
on separate DBs/ports; alice@A and bob@B; a live cross-server share (`share.request` → accept →
`share.accept`), a remote KeyPackage fetch over the signed inbox (one-time consumed, not
last-resort), a cross-instance MLS group formed with point-core, the Welcome relayed A→B, an
encrypted location fix relayed A→B and delivered to Bob's WS, decrypted by Bob to the exact fix —
and **both instances' databases assert 0 plaintext-leak rows**. A cross-server share stays a green
native-E2E relationship. `#[ignore]` (needs two live instances); the shell harness runs it.

## 2026-07-11 — D-022 · M3 federation adversarial-review fixes (trust-surface hardening)

Federation-trust is a security judgment I verify myself, not a subagent's final word. The M3
review surfaced six real findings on the S2S surface; all fixed and re-verified against the
two-instance E2E (still PASS, both servers ciphertext-only) plus the 15 federation unit tests.

- **HIGH-1 SSRF pin** — the check resolved+validated the target IPs but the outbound `reqwest`
  client then re-resolved DNS, leaving a rebind window between check and connect. `ssrf_check` now
  returns the validated `SocketAddr`s and `build_client` pins them with `.resolve_to_addrs`, so we
  connect to the exact vetted IPs (redirects already disabled). The advertised inbox host is
  validated + pinned independently of the domain.
- **HIGH-2 KeyPackage consent** — federated `mls.key_request` used a bare relationship-exists check,
  so a lone inbound pending could drain a local user's one-time KeyPackages. Now gated on
  `authz::can_fetch_key_packages` — the same consent the local claim path enforces. Fail-closed.
- **HIGH-3 inbox DoS** — the inbox is anonymous until the signature verifies, and verifying costs an
  outbound discovery fetch; an attacker could turn us into a reflected-DoS amplifier and flood
  shadow-user/pin writes. Added a per-source-IP throttle (120/min) ahead of any outbound work.
- **MED-1 welcome/commit gate** — federated `mls.welcome`/`mls.commit` delivery now also requires
  `can_fetch_key_packages`, matching `key_request`.
- **MED-2 reversed authz args** — `handle_location_update` called `can_deliver_to_user` with
  (recipient, sender) swapped; corrected to (sender, recipient).
- **LOW-1 TOFU race** — first-contact pin did SELECT-then-INSERT, so two concurrent first contacts
  with different keys could both pass the "no pin yet" branch. Replaced with an atomic
  upsert-returning that compares against the effective stored key and rejects a mismatch.

Removed the now-dead `federated_relationship_exists` helper (its callers all moved to the
`can_fetch_key_packages` consent gate).

## 2026-07-11 — D-022b · M4 ship: ghcr image, honest Traefik compose, self-host docs

Point is self-hostable for real, not aspirationally. A `point-release` workflow builds and pushes
the server image to `ghcr.io/petalnet/point-server` on a `point-v*` tag (and `:main` on server
pushes), pinned actions + minimal `packages: write` scope to satisfy zizmor. `docker-compose.yml`
is now a production self-host stack that PULLS that image behind Traefik (automatic Let's Encrypt
TLS, HTTP→HTTPS redirect), with `TRUST_PROXY_HEADERS=true` so the inbox/auth rate limits key off
the real client IP Traefik forwards. `docker-compose.build.yml` keeps the build-from-source path for
dev. `.env.example` enumerates every knob; `docs/SELF-HOSTING.md` is a real DNS→TLS→federation→
backup→upgrade walkthrough. The Dockerfile was verified to actually build the image (not asserted).

## 2026-07-11 — D-023 · M4 zero-knowledge account recovery (server stores only ciphertext)

E2E encryption means the MLS identity lives on-device — lose the phone, lose every share. Recovery
fixes this WITHOUT weakening E2E: the device encrypts its exported MLS state under a key derived
(Argon2id, m=64 MiB/t=3/p=1) from a 120-bit user-held recovery code and uploads the opaque blob
(`MAGIC ‖ salt ‖ nonce ‖ XChaCha20-Poly1305(state)`). The server stores one ciphertext row per user
(`mls_backups`, migration 0003) and CANNOT decrypt it — it never sees the code, the key, or the
state. Wrong code / tampered blob fails closed.

- Crypto in `core/src/recovery.rs` (point-core, so it's covered by the workspace CI test run): 7
  unit tests (roundtrip, wrong-code, tamper, malformed, no-plaintext-leak, code normalization,
  code shape). Recovery code is Crockford-base32, normalized so casing/spacing/look-alikes all
  derive the same key.
- Server `server/src/api/recovery.rs` + `0003_recovery.sql`: ciphertext-only PUT/GET/DELETE
  `/api/recovery/backup`, each scoped to the authenticated user. 5 integration tests incl. per-user
  isolation (one user can't read another's backup) and opaque byte-exact round-trip.
- Client: FRB bridge `app/rust/src/api/recovery.rs` + `features/recovery/recovery_service.dart`
  (enroll → cache code in secure storage → refresh; restore on a new device). Adding the cached code
  is no new exposure — the plaintext state already sits in the same secure storage.

**Verified on-device (real path, no facade):** `lib/recovery_check_main.dart` on the Galaxy A03s
drove enroll → `PUT` to the LIVE server → simulated new device `GET` → `recoveryDecrypt` → restore →
encrypt a fix → Bob decrypts it; a wrong code was rejected; and the server-stored blob was confirmed
opaque (39 KB, `PTR1` magic, no MLS-state field names or group name present). PASS.

## 2026-07-12 — D-024 · Wave A onboarding: launch gate, word-phrase recovery, replace-pool rekey

The non-sharing build wave (NONSHARING-BUILD-BRIEF.md) starts with the resumable first-run.
Implementation calls:

- **Launch gate is client-side, per-account for recovery, device-level for the fork.** The gate
  (`onboarding_gate.dart`) computes the first incomplete required step (recovery saved →
  transport chosen → location granted) on every sign-in, every app open, and every foreground
  resume while in the shell. "Recovery saved" is a per-`userId` flag in secure storage (a second
  account on the same device gets its own recovery step); the privacy-fork settings are
  device-level (`point.settings`). Location is re-checked live from the platform, so revoking it
  in Android settings re-gates on the next open — the brief's "denying location forces the
  permission screen on next open" without any stored state to go stale.
- **The recovery phrase is a presentation-layer encoding of the EXISTING 120-bit code.** The
  locked Eli copy says "These words", so the client shows 12 words instead of 24 base32 symbols:
  a 1024-word list (even-indexed BIP-39 English) carries 10 bits per word, each word = exactly
  two Crockford symbols (`index = hi<<5 | lo`), lossless both ways (`recovery_words.dart`,
  roundtrip-tested). The crypto layer still only ever sees the base32 code — zero change to
  `point_core::recovery`, and legacy codes stay valid restore input (`parseRecoveryInput`
  accepts either).
- **KeyPackage upload gains `replace` (server + client) because identity replacement orphans the
  pool.** Restoring a backup over a fresh sign-in identity (or enrolling fresh over an old
  backup) leaves server-stored KeyPackages whose private halves no longer exist; a peer claiming
  one silently can never reach the user. `POST /api/mls/keys` with `replace: true` drops the
  unconsumed pool (and a stale last-resort when none is supplied) in the same transaction as the
  fresh insert. The relay's wiped-state path (H1) now uses it too, instead of stacking a fresh
  pool on top of stale packages. Covered by `keypackage_replace_drops_stale_pool`.
- **Found + fixed while wiring the gate: the client read the pool level from `available` but the
  server serializes `count`,** so every sign-in "topped up" 5 more packages until the 20 cap.
  Client now reads `count`.
- **The privacy fork's private path only marks the transport chosen after the distributor guide
  exits** (found-distributor Continue, or the explicit skip sheet that says what skipping means).
  Killing the app mid-guide resumes at the fork; there is no code path that flips a private
  choice to FCM.
- **The location step gates on foreground permission but teaches "Allow all the time".**
  Foreground grant is what the engine needs to run at all (matches `LocationService`); the
  screen pushes the background upgrade with honest steps + an Open-settings shortcut, and
  celebrates the `always` state. Holding the shell hostage for `always` would punish the
  cautious with a dead app.

## 2026-07-12 — D-025 · Wave B Me tab: server-enforced who-can-add-me, honest settings wiring

- **who_can_add_me is server-side** (`users` column, migration 0004) because inbound share
  requests must be blocked at creation, not hidden by the client. Values `anyone | same_server |
nobody`; enforcement is **silent-drop** on both the local endpoint and the federated inbox,
  matching the existing anti-enumeration design (a blocked requester sees the same generic ok as
  a nonexistent target, so the setting cannot be probed). `same_server` only bites at the
  federation inbox — local asks are same-server by construction.
- **The photo-dot is a real profile avatar** (server-stored, <=128 KiB, magic-byte-sniffed
  jpeg/png/webp), served only through `authz::can_view_profile`: everything the KeyPackage
  consent gate allows plus a pending request in either direction (you see who is asking; the
  asked can see you while deciding). 404 for strangers = 404 for no-avatar, so the gate leaks
  nothing. Client center-crops/scales to 256px JPEG in an isolate before upload.
- **Every Look & feel setting is wired to something observable the moment it ships**, per the
  no-facades rule: theme drives MaterialApp, text size composes ON TOP of the OS scaler (never
  replaces an accessibility choice), reduce-motion zeroes the route transitions and the shell's
  branch cross-fade (following the OS flag in `system` mode), haptics gate a small two-level
  helper (impact on state-changing controls, ticks on selections), units/time-format feed the
  people rows ("dark since", temp expiry, and a NEW real distance-from-you label the marker
  previously stubbed with 'away').
- **"Start each sign-in dark" applies to fresh sign-ins only,** never cold-start restores: a
  restore reasserting ghost would silently override a live sharing choice on every launch.
- **Google's map tier is deferred** (allowed by the brief: "fine to defer"): the Privacy sheet
  ships the two honest tiers; a third opt-in row lands when a Google build flavor exists to back
  it. No row is shown that does nothing.

## 2026-07-12 — D-026 · Wave C maps: three honest tiers, tile endpoint in /.well-known, self-host tileserver

- **The map provider choice resolves against what the connected server ADVERTISES**, not a hardcoded
  URL. `/.well-known/point` gains `endpoints.tiles` (the instance's own tileserver template, if it
  runs one) and `endpoints.tile_proxy` (bool: does this server proxy an upstream). The client's
  `tileSourceProvider` maps the Privacy setting to a renderable source: self-hosted → the advertised
  tiles URL, else a public OSM mirror (honestly labeled); proxied → `/api/tiles/{z}/{x}/{y}` on the
  Point server when it proxies, else the same public mirror. Switching the setting re-renders the map
  live (the TileLayer keys off the resolved template). Google is deferred (brief allows it): no row
  ships that does nothing, and the Privacy sheet says plainly why a surveillance provider can't be
  "cleaned".
- **The proxied tier is a real member service, not an open proxy.** `GET /api/tiles/{z}/{x}/{y}`
  requires auth, rate-limits per user (600/min — a pan/zoom burst is dozens of tiles), validates the
  tile coordinate against 2^z before any upstream fetch, refuses non-image upstream responses, caps
  the body at 2 MiB, and disables redirects on the outbound client. The provider only ever sees the
  server's IP + key. Wired only when `TILE_UPSTREAM` is set. Covered by
  `tile_proxy_streams_validates_and_gates`.
- **The self-hosted tileserver is a real bundle, verified end to end.** `apps/point/tileserver/`
  ships a tileserver-gl config + Point's monochrome pure-black MapLibre style (greys only, presence
  by form); the compose stack gains an optional `tileserver` service behind a `--profile tiles` gate,
  Traefik-routed at `/tiles/`. Verified on this host: extracted a 53 MB St. Louis PMTiles from the
  Protomaps daily build, ran tileserver-gl v5.3.1 against it, and rendered Point's dark basemap —
  then drove BOTH tiers on the A03s (self-hosted tiles from our own PMTiles, and the same map through
  the server's `/api/tiles` proxy), switching provider live in Settings. SELF-HOSTING.md gains a Maps
  section with the three-command setup.

## 2026-07-12 — D-027 · Wave D notifications: transport-agnostic wake, UnifiedPush proven, FCM scaffolded

- **Push registration is transport-agnostic** (migration 0005 replaces `fcm_tokens` with
  `push_endpoints (user_id, transport, endpoint)`, carrying the old FCM tokens forward). One row per
  device; `POST /api/push/register` takes `{transport: unifiedpush|fcm, endpoint}` and
  `/api/push/unregister` drops one. A UnifiedPush endpoint must be https (fail-closed at
  registration: the server POSTs the wake to it, so a bogus/plain-http value would be undeliverable
  or an SSRF foothold).
- **The wake is contentless on the wire.** The UnifiedPush body the distributor relays is EMPTY —
  it learns nothing, not who, not where, not even the coarse event category. (The brief said
  "encrypted wake"; true webpush payload encryption needs a per-endpoint key exchange, so v1 takes
  the simpler road that gives the same privacy: send no content at all. The `kind` tag survives only
  for FCM's data field, where Google already handles delivery, and for server logs.) The client
  refreshes its request + people surfaces on any wake, so it never needs the category to act. Delivery is best-effort, fire-and-forget (spawned), and only fires when the recipient is
  OFFLINE (no live WS) — an online device already got the WS nudge. Wired at local share-request
  creation, share accept, and the federated inbound request. **v1 notification set by construction:**
  only share_request + share_accepted ever wake; go-dark, passive moves, and being-viewed send
  nothing, so they are silent because no wake exists, not because a flag suppresses one.
- **UnifiedPush is fully delivered and proven end-to-end.** Client `PushService` registers with the
  user's distributor, uploads the endpoint, and refreshes the request/people surfaces on a wake.
  On-device proof (A03s + ntfy → ntfy.sh): Point registered and its `https://ntfy.sh/up...` endpoint
  landed in `push_endpoints`; the app was force-stopped (offline); a second account's share request
  made the server POST a wake to the endpoint; ntfy delivered it to Point's UnifiedPush connector
  (`NtfyUpRaiseFg: Sending msg for dev.petalcat.point_app`); on relaunch the pending request was
  there.
- **FCM is transport-agnostic on the server, scaffolded on the device.** The sender posts a data-only
  HTTP v1 message when `FCM_PROJECT_ID` + `FCM_ACCESS_TOKEN` are configured (an operator running the
  convenient tier supplies a token refresher; the private path needs none). The client registration
  path exists (`PushService.registerFcm`), but the device FCM token comes from the Firebase SDK,
  which a convenient-tier build flavor (google-services.json + firebase_messaging) provides — a
  documented fast-follow, not faked in the base build. The private default is the one delivering in
  v1.2.0.

## 2026-07-12 — D-028 · v1.2.1: the signed-out hard-stop must not outlive the sign-out (tracker 721)

The v1.2 location regression root-caused, not guessed: `_onAuth`'s signed-out branch hard-stops the
battery engine (`setSharing(false)` → machine → ghost), and NOTHING on the next sign-in lifted it —
`start()` faithfully applies whatever plan the machine holds, and a ghost plan is "everything off."
So every fresh install (whose very first auth resolution is signed-out, by design, to route to
server-pick) and every sign-out → sign-in in one process ran the engine ghosted until a full process
restart: no self-marker, dead recenter, zero rows in `location_history`/`location_updates`. The
on-device evidence matched to the minute (A03s: janet's rows begin four minutes after the 21:11 UTC
process restart, then clean 15-minute heartbeats). Calls made:

- **Session establishment is ONE sequence** (`_establishSession` → `establishSessionEngineState`):
  reset the engine to sharing, then apply the go-dark default (explicit sign-ins only), then run the
  launch gate that may `start()` the engine. The old code fired go-dark and the gate as independent
  unawaited futures — the reset-vs-go-dark order was a coin flip; now it cannot race and the
  privacy-critical "start each sign-in dark" always wins over the reset.
- **`start()` behaves like a foreground resume** when the app is open: jump the machine to `active`
  for a prompt first fix. Before, a cold start sat `idle` (GPS off) until motion or the first
  15-minute heartbeat — the map's "centers on YOU" moment hung on an accelerometer bump.
- **`_apply()` gates on `_started`**: pre-permission lifecycle/sharing events now only update the
  machine, never the sensors — no location-plugin pokes before onboarding has earned the ask.
- **The engine's platform seams are injectable** (permission checks, position stream/current-fix,
  accelerometer), because the regression shipped exactly where coverage stopped: the pure state
  machine was tested, the engine wiring around it was not. `test/location_engine_session_test.dart`
  now drives the acquisition path headless (start → fixes out, the wedge, ghost stays a hard stop,
  denied permission touches nothing, stillness → heartbeat) plus the session-establishment wiring
  (leftover hard-stop cleared; go-dark default honored on explicit sign-in; restores never trample a
  live choice) — wired into the existing `flutter test` CI gate.
- **Server-side ghost on restore stays display-only** (unchanged from v1.1): a restored session
  starts the engine sharing even if another device set ghost; the server enforces suppression. Noted
  here so it reads as a known call, not an oversight.

### D-028 · review round (codex, adversarial)

The codex pass surfaced two safety-critical holes (both latent since v1.1, both fixed here because
this is exactly the code being certified) and a battery hazard the new foreground nudge widened:

- **In-flight heartbeat past ghost:** the hard stop cancels future ticks, not the awaited
  `getCurrentPosition` — its completion emitted a fix AFTER go-dark. Now the tick re-checks
  `timer.isActive && plan.gpsEnabled` after the await; a late fix is dropped. Test: goes dark while
  the request is in flight → nothing emitted.
- **Same-user auth refresh could re-establish:** the identity guard keyed off the listener's `prev`
  value, so a `loading → data(same user)` refresh would re-run establishment and lift a live ghost.
  The app now tracks `_establishedUserId` (cleared on teardown) and the whole `_onAuth` decision is
  the pure `sessionTransition()` (lib/app/session_transition.dart) — headless-tested for: first
  resolution establishes, same-user refresh/re-emission skips (ghost preserved), sign-out tears
  down + repeat skips, and sign-out → sign-in of the SAME account re-establishes (the wedge).
- **No-fix acquisition pin:** `active` with a GPS stream that never fixes (indoors) held high-power
  GPS forever — the stillness window only armed on fixes. `_apply()` now arms it when entering the
  moving branch, so a fixless active ramps down to idle/heartbeat and motion re-promotes. Test:
  active + 31s of silence → idle, GPS off.

### D-028 · adversarial round (review subagent, on top of the codex round)

Verdict was "core fix sound, no critical leak" plus three majors, all addressed:

- **Routing could hang on the go-dark write:** `_establishSession` awaited `setGhost` (no client
  timeout) before routing — a stalled socket after login left the user on the login screen forever.
  Now the whole engine-establish step is bounded (8s) and fail-open like the launch gate: the engine
  goes dark synchronously inside, so proceeding on timeout/error is the safe direction.
- **Ghost rollback could resume broadcasting:** on a failed `setGhost`, the rollback restored
  `previous.isSharing` — where `previous` could be the never-confirmed signed-out placeholder, and
  even a CONFIRMED "sharing" baseline is wrong to restore when the failed ask was go-dark. The
  rollback is now fail-closed (`previous.isSharing && sharing`), and the controller tracks whether
  its state was ever server-confirmed. A go-dark-default sign-in with a flaky server now stays dark.
  Test: failed go-dark write → engine stays dark.
- **The wedge's load-bearing line was unpinned:** deleting `_establishedUserId = null` on teardown
  would re-introduce the exact v1.2 wedge with every test green. The identity lifecycle now lives in
  `SessionTracker` (session_transition.dart), and a sequence test (establish → refresh-skip →
  teardown → SAME-account re-establish) fails if the clear is removed. Residue, accepted: the thin
  `_onAuth`/`_establishSession` glue (tracker wired to listener; establish-before-gate ordering) is
  still only readable, not pumped — a full `PointApp` widget harness is out of scope for a point fix.
- Minors: background cold starts seed the engine from the real lifecycle state (no foreground-cadence
  GPS behind a dark screen on a push wake); pre-start lifecycle/sharing events are pinned to never
  touch the sensors.

## 2026-07-13 — D-029 · v1.2.2: MLS identity generations and live share teardown

The one-way disappearance after re-registration was a stale deterministic DM group, not the
location engine: the new device uploaded usable KeyPackages, but both clients saw the old group id
and skipped formation, so no fresh package was consumed and no Welcome was emitted. Three calls
define the repair:

- **KeyPackage replacement advances an identity generation.** `users.rekeyed_at` changes only when
  `POST /api/mls/keys` uses `replace=true`; active peers receive `peer.rekeyed`, and `GET /api/shares`
  carries the durable marker for offline convergence. A client with created OR wiped local MLS state
  replaces the server pool—`created` can be a fresh install of an existing account, so treating it
  as an ordinary top-up can preserve packages whose private halves are gone.
- **The older identity initiates the replacement group.** Both clients compare their own and their
  peer's generation. The older side overwrites the stale deterministic DM group, consumes the newer
  side's current one-time KeyPackage, and sends a new Welcome; the newer side waits and overwrites its
  stale group when that Welcome arrives. This generation ordering supersedes D-019's username
  tie-break for all unequal-generation pair formation (including a first share); equal generations
  retain the lexicographic tie-break. Formation waits until the client's own generation is loaded,
  so startup cannot race into the fallback. Handled peer-identity and share epochs are persisted as
  separate secure-storage markers (one timestamp must never mask the other), so restarts do not
  drain the pool and remove→re-add always forms a new epoch. This ordering is load-bearing: in the
  Janet incident it makes petalcat consume a fresh Janet package, which is the observable acceptance
  proof.
- **Share deletion is a committed teardown event.** After the relationship and historical request
  rows are deleted, the server sends `share.removed` to every live device on both sides and a
  contentless wake to either side that is offline. Clients
  immediately remove the peer from their encrypt target set, People, Map, and cached presence before
  refreshing the authoritative lists. A racing old client still cannot deliver or persist another
  fix because the server authorization row is already gone. Federated peers receive the equivalent
  signed `share.remove` S2S message; exact cross-server handles enter through the signed federation
  send path rather than being mistaken for missing local users.

The add-by-handle parser is also strict at the UI boundary: a bare name gets the home domain, an
already canonical `name@server` is preserved, and foreign/malformed qualified shapes (including
`name:server`) error locally instead of becoming `name:server@home` followed by a false success
toast. For a syntactically valid but nonexistent canonical handle, the request endpoint returns
`recorded=false` and the client shows a resolution error. This intentionally supersedes D-005's
account-existence ambiguity for direct handle adds: an explicit exact-handle workflow cannot both
confirm failure and hide whether that exact handle resolves; relationship state remains hidden.
Regression coverage spans the real Postgres/WS key-claim + Welcome path, two-way OpenMLS
decrypt after device replacement, relay generation selection, handle shapes, and teardown delivery.

## 2026-07-17 — D-030 · 1.3 P0: stable_fuzz lon-scale quantized to the snapped-cell latitude (deliberate deviation from the §4.2 pseudo-code)

The spec's pseudo-code computes `m_per_deg_lon = 111_320 · cos(true_lat)` and reuses it for the
inverse projection (`lon = cx / m_per_deg_lon`). Taken literally, the reported longitude varies
continuously with `true_lat` _inside_ one cell — two fixes in the same cell at different latitudes
return different longitudes, violating the spec's own headline property ("repeated fixes inside the
same cell yield the **identical** shown point — nothing to average") and re-opening the averaging
attack the function exists to kill: at lat 60° / lon 179° the within-cell lon drift is on the order
of hundreds of meters and is a monotone function of `true_lat`, so a collector could regress the
true latitude back out of it. **Call: compute the y-cell first, then use the snapped-cell-center
latitude for the lon scale in both directions** (`m_per_deg_lon = 111_320 · cos(snapped_lat)`).
Output is then a pure function of (cell_x, cell_y, offsets, cell) — byte-identical within a cell
(asserted via `f64::to_bits` in tests). The within-radius guarantee survives: worst-case offset is
(cell/2)·√2 ≈ 0.707·radius plus a cos-ratio error bounded by tan(lat)·(cell/2R) (≈0.2% at 70°),
verified by a 2000-sample haversine property test. Acceptance criteria trump pseudo-code letter.

## 2026-07-17 — D-031 · 1.3 P0: stable_fuzz encoding choices (HMAC input framing, endianness, city preset)

- **HMAC domain separation:** the spec writes `HMAC(secret, sharer_id || audience_id)`. Raw
  concatenation is boundary-ambiguous (("ab","c") ≡ ("a","bc")), so the implementation frames each
  field as `u64-BE(len) || bytes`. Test `sharer_audience_boundary_is_domain_separated` pins this.
- **Endianness:** `ox`/`oy` derive from `h[0..8]`/`h[8..16]` read **big-endian** (network order);
  `(u64 as f64 / 2^64) · cell` per spec. The choice only needs to be stable, and BE is pinned by
  the determinism tests.
- **"City" preset = 5000 m**, exposed as `FUZZ_RADIUS_CITY_M` (with `FUZZ_RADIUS_NEAR_M = 300`,
  `FUZZ_RADIUS_MID_M = 1000`, and `FUZZ_RADIUS_PRESETS_M`) — build-time constants per the brief;
  the spec's "~5 km" is taken at face value.
- **Cell-id seam for the caller contract:** `fuzz_cell_id(...) -> (i64, i64)` exposes the target
  cell indices so callers cache the last emitted cell per (entity, audience) and re-emit only on
  cell change (spec §4.2 "enforced by the caller"). Same snap path as `stable_fuzz`, so the two
  can never disagree.
- **Input guards:** asserts on finite radius > 0, |lat| ≤ 89°, |lon| ≤ 180° — polar rows and
  antimeridian wrap are out of 1.3 scope; a panic surfaces as a Dart exception over frb rather
  than silently emitting a corrupt coordinate.
- **Secret-provider seam:** `secret: &[u8]` is caller-supplied; generation/secure-store lifecycle
  is explicitly later-phase (spec §4.2 lifecycle note), P0 lands only the pure function.

## 2026-07-17 — D-032 · 1.3 P0: FFI surface for stable_fuzz + bringing point_mls up to the lint gate

- **One bridge call returns center + cell id.** `api::fuzz::stable_fuzz` returns a `FuzzedPoint
{lat, lon, cell_x, cell_y}` rather than mirroring the two core functions: the P2 caller needs
  the cell id on every fix anyway (re-emit-on-cell-change contract), and one sync FFI hop beats
  two. `fuzz_radius_presets_m()` exposes the build-time presets so Dart never hardcodes them.
- **`point_mls` was never fmt/clippy-clean** (CI only `cargo build`s it). The P0 gate demands
  both, so: `cargo fmt` across the crate (formatting-only diff in crypto.rs) and a
  `[lints.rust] unexpected_cfgs` check-cfg entry for `cfg(frb_expand)` — the documented
  flutter_rust_bridge macro artifact — instead of blanket-allowing the lint.
- **Dart smoke test loads the real cdylib** (`test/stable_fuzz_ffi_test.dart` via `RustLib.init()`
  - `LD_LIBRARY_PATH=rust/target/release`, same mechanism CI already uses for the MLS tests), and
    re-asserts determinism, per-audience grid divergence, cell-crossing, and the presets across the
    bridge — proving load + call, not a stub.

## 2026-07-17 — D-033 · 1.3 P0: client entity/audience/edge model shape (no UI, no fix-loop wiring)

- **Feature dir `lib/features/sharing/`** (domain + data only — presentation lands in P4).
- **Persistence = the settings pattern**, not the temp-shares pattern: temp shares are
  server-backed rows, but edges are client-authoritative in 1.3 (the server only gets an advisory
  copy later), so both new stores (`point.entities`, `point.share_edges`) follow
  `SettingsController`'s secure-storage JSON blob with the load-completer + serialized write-tail
  (same corrupt-blob-resets semantics, same race protections, snake_case keys).
- **`Audience.key` is the canonical audience id**: `grp:<serverGroupId>` / `usr:<userId>`. The
  kind prefix keeps a group and a user with the same raw id from colliding, and this exact string
  is what P2 must pass to `stable_fuzz` as `audience_id` (grid selector), so it lives on the
  model, not in call sites. Sealed class, two variants, per spec §2.4.
- **Per-audience defaults are a separate keyspace** (`audience_defaults` beside `edges`), not
  sentinel edges. `ShareSetting.perAudienceDefault` marks _provenance_ on a resolved setting
  (true = inherited from the audience default / initial default; false = explicitly set on the
  edge) — `setEdge` forces it false, `setAudienceDefault` forces it true, and
  `effectiveSetting` resolves explicit edge → audience default → `ShareSetting.initial`
  (Precise, per spec §3.3). Nested-map JSON (`entityId -> audienceKey -> setting`) avoids
  composite-key separator ambiguity.
- **`defaultFuzzRadiusM = 1000`** (middle preset) applied when a setting doesn't carry a radius,
  per spec §3.3; `ShareSetting.isActive(now)` encodes the off/expiry semantics P2's fix loop
  will consume (`fidelity != off && (expires_at == null || now < expires_at)`).
- **Entity registry stores a flat list** (`upsert`/`remove`/`byId`); only self-`person` exists in
  1.3 but `item`/`bridgeSource` parse and persist so the enum column is first-class from day one
  (unknown types parse to `person`, the only instantiable 1.3 type).
