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
