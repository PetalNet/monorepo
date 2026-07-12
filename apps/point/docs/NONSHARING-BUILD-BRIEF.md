# Point v1.1 → v1.2 — Non-sharing sections build wave

The sharing UX is done (7 waves merged, v1.1.0 shipped, device-to-device proven live on the real
server). This wave builds the rest of the shell: the five non-sharing sections charted on the wayfinder
map, refined by Parker's live dogfooding. Build them wave by wave.

Companion specs already in the repo — read them first: `apps/point/docs/design/UI-SPEC-FINAL.md`,
`SHARING-UX-SPEC.md`, `design-direction.md`, `DECISIONS.md`. Match the existing app: kaisel routing
(`lib/app/routes.dart`, `point_app.dart`), Riverpod, `theme_x`/`app_theme`/`shell_chrome`, monochrome
pure-black OLED, Schibsted Grotesk, AppRadii tokens.

## The bar (non-negotiable — hold it on every screen)

- **/impeccable + eli-design-mode on EVERY screen.** Monochrome pure-black OLED, presence by form not
  color, borderless surfaces (hairline + elevation, never card borders or faked inset shadows),
  Lucide-style icons (no emoji), 8pt grid, small radii from tokens.
- **Copy must be clear and eli-approved.** Minimal, positive, **em-dash-free**. Every user-facing string
  reads like a human wrote it. Parker specifically called out: "make the wording clear and eli approved."
- **Extend, don't reinvent** existing components.

## Engineering discipline (the core rule — no shortcuts)

- **PR → review → merge per wave.** Each wave is its own branch. Run codex + an adversarial review before
  merge; land must-fix findings first. **No patches; main gets only merged code.** Self-merge your own PRs
  after review + green CI (main is branch-protected: PR + 5 status checks incl CodeQL required — you cannot
  direct-push).
- **Test on the separate domain/DB** (`localhost:8330` / `point_test`), prod untouched. **No facades** —
  drive the real path (real requests, real MLS, real render).
- **Dart MCP render loop** for UI. **On-device verify every wave** on the Galaxy A03s (`adb -s R9WWC0AEE2P`).
- **Version** per A.B.C (A=breaking, B=feature, C=fix). This wave is a feature set → bump to **1.2.0**.
- **Ship** a fresh release APK when the wave completes (arm64 split ≤50MB for delivery). Deploy server
  changes to `/home/docker/point-prod` (image `ghcr.io/petalnet/point-server`).
- **Blockers:** a real question → dated entry in `/home/docker/point-fable/BLOCKERS.md`, then keep working
  everything that isn't blocked.

---

## Wave A — Onboarding rebuild

The real resumable first-run, plus a force-uncompleted gate. Today the router just does login → shell and
requests location permission without enforcing it.

**Sequence, in order:** (1) pick home server → (2) create/log into account → (3) **save recovery phrase**
(Wave E, right after account, before the location ask) → (4) **privacy/why screen** (E2EE story + the
privacy fork below; sits before the permission ask so it earns the grant) → (5) **location permission**
("allow all the time", with clear how-to instructions, shown only if not already granted) → (6) Map.

**Force uncompleted sections on open:** a launch gate. If a session exists but any required step is
incomplete (recovery not saved, transport not chosen, location permission not granted), route into that
step instead of the shell and resume exactly where they left off. Reopening never drops someone into a
half-set-up app.

**The privacy fork (on the why screen):** one plain-language choice (not two technical dropdowns) that sets
map + notification transport together; fine-tunable later in Settings.
- **Private by default** → self-hosted/OSM map + UnifiedPush notifications.
- **Convenient** → proxied vector map + FCM. (NOT Google — see Wave C.)
- If Private: **guide them through the UnifiedPush distributor setup** (show ntfy + options, walk the
  install/config). **No silent fallback to FCM** that undoes the choice.

**Done when:** a fresh install walks the full sequence; kill mid-flow + reopen resumes into the right step;
denying location forces the permission screen on next open; the fork sets map + transport and Private guides
distributor setup.

## Wave B — The Me / Settings tab

Settings is NOT a separate destination — it merges with the You tab into the third nav tab.
- **Surface:** borderless me-header (photo-dot, name, @handle·server; tap → identity editor for name +
  photo-dot), a hairline, then the ghost/go-dark toggle as the one live control, then the category list.
- **Privacy** — map provider (lives here; deep-link target from Look & feel), who-can-add-me, go-dark default.
- **Look & feel** — theme (Light/Dark/Pure-Black), reduced motion (follows OS + override), haptics
  (None/Standard/Enhanced), units (mi/km), text size, time format (12/24h), + a "Map provider" row that
  deep-links into Privacy.
- **Notifications** — transport + fallback (Wave D) + the v1 notification set.
- **Account** — server, sign out, account recovery (Wave E).
- **About** — version, privacy, licenses.

Eli: no card border/shadow on the header — header block + hairline. Simple settings inline; heavier ones
drill into their own sub-screen.

**Done when:** the third tab is the Me screen with header + grouped categories; the old You tab is gone;
map-provider has one home (Privacy) with a working deep-link from Look & feel; identity edit works.

## Wave C — Map providers (three honest tiers, no cleaning theater)

Wire the choice from the Privacy setting + onboarding fork through to the render. **Do NOT try to make
Google "a little private"** — half-neutering a surveillance company is a lie that gives false comfort. Each
tier is what it says.
- **Self-hosted OSM (default, max private)** — MapLibre/flutter_map with the existing monochrome style,
  tiles from the home-server's own tileserver (below). Map data never leaves your people's servers.
- **Proxied vector provider (clean + convenient)** — Protomaps or Stadia, requests routed *through the
  Point server* so the provider only ever sees the server, never the user. Real privacy, still polished.
  This is the "convenient" default, not Google.
- **Google (honest opt-in, or deferred)** — offered only if the user digs for it in Privacy, labeled
  plainly: "Best detail. Google sees where you look. Not private." App talks to Google directly (their
  terms forbid proxying their tiles, so it can't be cleaned). Fine to defer to a later "max detail" toggle.

**Self-hosted tileserver in the bundle:** the self-host docker-compose optionally spins up a tileserver
(Protomaps PMTiles via tileserver-gl) next to the Point server; the server advertises its tile endpoint in
`/.well-known/point`; the app uses the connected home-server's tiles for the OSM map. Hosted OSM/Protomaps
endpoint as fallback when an instance runs none. Same MapLibre style either way — the tile source is a URL.

**Done when:** switching provider changes the rendered map live; OSM keeps the monochrome style; the app
reads the tile endpoint from `/.well-known` with a hosted fallback; the self-host compose has an optional
tileserver service + docs.

## Wave D — Notifications transport

Nothing delivers today (client has only an FCM hook, server a token endpoint). This was Parker's original
miss — he got no push for a share request. Build the real transport.
- **UnifiedPush primary** — client registers with the user's distributor; self-host **ntfy** for the
  default UP endpoint. Server pushes an encrypted wake (distributor sees "wake Point", not who/where).
- **FCM fallback** — a path/flavor for the convenient choice or no-distributor users.
- **Per-user setting** (Notifications) — pick transport AND whether to fall back; set initially by the
  onboarding privacy fork.
- **Server:** generalize `/api/fcm/token` to transport-agnostic endpoint registration (UP URL or FCM token).
- **v1 notification set:** push for an incoming share request and for accept/started-sharing; temp-expiry
  in-app only; **silent always** for go-dark, passive moves, being viewed. Arrival/place alerts deferred.

**Done when:** a share request delivers a real push via UnifiedPush end-to-end; switching transport/fallback
in Settings works; FCM path delivers for the convenient choice; go-dark stays silent.

## Wave E — Account recovery UX

Surface the existing zero-knowledge recovery, honestly. If the phrase is lost, nobody restores the account.
- **Set-up in onboarding** (Wave A), right after account, before the location ask. A recovery phrase the
  user saves (write down / password manager), gated on a "stored it somewhere safe" confirm.
- **Recover on a new device** — "Recover account" → server + phrase → keys restored → back in.
- **Always reachable** at Account → Recovery.
- **Eli copy (locked):** Title "Save your recovery phrase". Body: "These words are the only way back into
  your account if you lose your device. Point is end-to-end encrypted, so no one can reset them for you, not
  even us. Write them down or keep them in your password manager." Primary: "I saved it."

**Done when:** onboarding produces + verifies a saved phrase; a fresh install recovers an account from
server + phrase on-device; copy is honest and em-dash-free.

---

## Sequencing

A (onboarding shell + fork) and B (the tab) first — C/D/E hang settings off them. C and D can run in
parallel once B lands. E's screens are built in A; its recover-flow is its own slice. Each wave: branch →
PR → codex + adversarial review → merge → on-device verify → (ship APK at wave end).

**Fast-follows (NOT this wave):** self-hosted Protomaps tile server hardening; arrival/place alerts
(reworked for Point's calm); accessibility split out of Look & feel if it grows.
