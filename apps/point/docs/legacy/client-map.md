# Legacy Flutter client — deep survey (reference for the M1 rewrite)

*Produced 2026-07-11 from `/home/docker/point/point/` (55 Dart files, ~17.6k LOC,
hooks_riverpod 3.x). Corrections to the brief's premises are flagged — the rewrite plans from
what the code actually is.*

## 1. The god-object

`lib/providers/location_provider.dart` — **`LocationNotifier`, 1203 lines** (not 1303, and not
`location_notifier.dart`). A `Notifier<LocationState>` owning: relay timers + buffer, position
cache (SharedPreferences, 30s debounce), GPS fix handling, activity→cadence mapping
(active=3s, fast=5s periodic relay), MLS encrypt+send (single + batch), zone learning feed,
zone enter/exit + synthetic zone-center relay, 10-min zone heartbeat, geofence eval (circle +
ray-cast polygon), ghost gating (its own `isGhostMode` flag), viewing/nudge scheduler
(15s/45s/2min adaptive), WS message handling (location.broadcast, presence.*, nudge), geo math.
Dependents: home_screen (orchestrator), map_view, place_creation_screen, person_history_screen,
person_detail_sheet.

Natural service seams (the banner regions): state-machine/relay/sharing/ghost/presence +
crypto — matches the spec's target decomposition.

## 2. Battery engine (lift the DESIGN)

`lib/services/location_service.dart` (657 lines) + `zone_learning_service.dart` (310).

- State machine `{sleeping, idle, active, fast, ghost}`: sleeping/idle→active on >5m movement,
  accel wake, or heartbeat >50m; active→fast at speed >5 m/s ×3 fixes; fast→active <2 m/s ×5;
  →sleeping via stillness timer (30s background / 2min foreground, graceful ramp-down);
  any→ghost kills GPS+accel+timers.
- Intervals: active 2–5s (ramp), fast 2s, background-moving 10–15s, background-sleeping passive
  60s/100m. Heartbeat every 15min (comments say 30/20 — code wins).
- Layer 1 accel gate: userAccelerometer @10Hz, 1.5 m/s², 5 frames (~500ms) wake / 30 frames
  (~3s) still. **Foreground only** — background substitutes passive GPS, no real
  significant-motion sensor.
- Layer 2 learned zones: dwell 100m/30min, promote at 3 dwells, radius 150m→refined,
  suppression at confidence ≥50, exit hysteresis 1.2×radius. **Persisted PLAINTEXT in
  SharedPreferences** (`learned_zones`/`learned_dwells`) — rewrite must encrypt at rest.
- Layer 3 demand nudge: 15s min interval; inbound nudge wakes GPS, bypasses suppression.
- Layer 4 relay filters: 5m threshold + ~10m degree-approx gate.
- Layer 5 foreground service: geolocator's `foregroundNotificationConfig`, only when
  `hasActiveShares`, wake-lock on.

## 3. Lifecycle hooks — brief's premise is STALE in this checkout

`home_screen.dart:32` HAS `WidgetsBindingObserver` wired (addObserver/didChangeAppLifecycleState
→ appOpened/appBackgrounded + setBackgrounded). The genuinely-unwired hooks are:
- **`LocationService.enterGhost()`/`exitGhost()` — zero call sites.** Ghost only suppresses
  relay; GPS+accel keep burning battery while "ghosted." Rewrite: GhostService drives the
  engine.
- **`GhostNotifier.updateCurrentPlace()` — zero call sites** (place-based ghost rules dead;
  moot for v1 since ghost is plain on/off).
- Dead v1-compat shims: startTracking/stopTracking/setMode.

## 4. Relay + WS defects (M2 targets)

- `relay_buffer.dart`: RAM-only list, max 20, 30s flush (interval owned by LocationNotifier).
  No disk persistence, no dedup, no retry, no acks — kill/background loses everything.
- `ws_service.dart`: auth-as-first-message on connect. Reconnect `min(2^n, 300)s` **no jitter**;
  **bug: `_isConnected=true` + `_reconnectAttempt=0` set optimistically in `_connect()` before
  the socket is proven healthy** → backoff never grows on a flapping link; sends silently drop
  when disconnected.

## 5. MLS integration (M2 targets)

- flutter_rust_bridge 2.12.0; `rust/src/api/crypto.rs` wraps point-core; Dart wrapper
  `lib/services/crypto_service.dart` (313 lines) holds `_groupIdMap` server-id→MLS-gid.
- **MLS state is NOT persisted at all** — in-memory provider, fresh identity every launch,
  `_groupIdMap` starts empty. (The rebuilt core crate already has export_state/restore; the
  rewrite persists via flutter_secure_storage.)
- Only auth token/userId/displayName/isAdmin are in flutter_secure_storage.
- **Single-KeyPackage bug locus**: `crypto_service.dart:32-41` uploads exactly one KP;
  `_addMemberByUserId` consumes `keyPackages.first`, re-uploads one after. Concurrent adds
  starve.
- Pairwise DM groups: deterministic `dm:<sortedA>:<sortedB>`.
- MLS message flow: pull `processPendingMessages` + realtime WS `mls.message`.

## 6. Sharing flows (client)

- Direct: sendRequest → accept → `crypto.setupDirectShare` creates pairwise MLS group.
- Temp share: targets a specific userId + duration/precision. **No share-link/URL flow exists
  client-side** (schema supports link_token; no UI/route).
- Groups: create (also creates MLS group), addMember (+MLS add), invite codes, join-by-code.
- `shareItem` posts to `/items/...` missing `/api` prefix (latent; items are v1.5 anyway).

## 7. Ghost (client)

Two competing mechanisms that can disagree: `GhostNotifier` (rules/timers/WorkManager
background eval, syncs `PUT /api/ghost`; persists global flag + timer expiry in
SharedPreferences) vs `LocationNotifier.isGhostMode` (just cancels relay timer, NOT persisted).
v1 = plain on/off: single GhostService, persisted, drives both server flag and the engine.

## 8. UI / boot / platform

- Boot: main() → RustLib.init (FRB), AppConfig.load, NotificationService.init,
  GhostNotifier.initBackground (workmanager 15-min periodic), optional Firebase; ProviderScope;
  AuthGate → HomeScreen (4-tab IndexedStack: Map/Sharing/Inbox/Profile) or LoginScreen.
- DI: `lib/providers.dart` — 8 service Providers + 7 NotifierProviders.
- Maps: dual-stack google_maps_flutter + flutter_map (OSM/mapbox/self-hosted) dispatched on
  AppConfig.mapProvider; `point_map.dart` unified wrapper.
- Android: fine/coarse/background location + FOREGROUND_SERVICE_LOCATION perms; custom
  geofence MethodChannel (`dev.petalcat.point/geofence`, Kotlin GeofenceManager +
  BroadcastReceiver, EXIT-only); FCM via push_service abstraction (firebase / unifiedpush /
  none); cleartextTraffic=false; allowBackup=false.
- Key deps: hooks_riverpod ^3.3.1, geolocator ^13, sensors_plus ^7, battery_plus ^6,
  workmanager ^0.9, web_socket_channel ^3, flutter_secure_storage ^10, google_maps_flutter
  ^2.17, flutter_map ^8.2, qr_flutter, unifiedpush ^6.2, firebase_messaging ^16.

## 9. Rewrite call-outs (ranked)

1. MLS zero persistence (GO-bar #2). 2. Ghost never stops the engine + dual ghost state
(GO-bar #6). 3. WS backoff bug + no jitter + RAM-only buffer (GO-bar #3). 4. Single-KeyPackage
starvation (GO-bar #4). 5. God-object seams per §1 (GO-bar #5). 6. Learned zones plaintext at
rest. 7. shareItem /api prefix (v1.5, fix in passing).
