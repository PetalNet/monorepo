import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:geolocator/geolocator.dart';
import 'package:point_app/features/location/domain/location_state_machine.dart';
import 'package:point_app/features/location/foreground_service.dart';
import 'package:sensors_plus/sensors_plus.dart';

/// The effective geolocator settings that reach the platform — the reopen guard
/// keys on this (R15). `foregroundNotificationConfig` is deliberately absent:
/// we run our own foreground service (DEFECT #2), so geolocator's is always null
/// and never part of the identity.
typedef _GpsKey = ({
  LocationAccuracy accuracy,
  int distanceFilter,
  int intervalMs,
});

/// A location fix ready for the relay (still plaintext here — encryption happens
/// in the crypto/relay layer before it leaves the device).
///
/// Two clocks, deliberately separate (the 1.2.11 go-dark fix):
/// - [timestampMs] is when the POSITION was actually sampled. It is NEVER
///   fabricated to `now`; a parked keepalive carries the real (older) sample
///   time so a viewer can tell "moving right now" from "sitting where they were
///   an hour ago".
/// - [aliveAtMs] is when the DEVICE last proved it is alive (this fix leaving
///   the device). For a live GPS fix the two coincide; for a parked keepalive
///   [aliveAtMs] is `now` while [timestampMs] stays old. Dark/alive is driven by
///   [aliveAtMs]; position freshness by [timestampMs].
/// - [parked] marks a keepalive/floor (position older than liveness) so the
///   viewer renders "parked · here since T" instead of a falsely-fresh "live".
class Fix {
  const Fix({
    required this.lat,
    required this.lon,
    required this.speed,
    required this.accuracy,
    required this.timestampMs,
    int? aliveAtMs,
    this.parked = false,
  }) : aliveAtMs = aliveAtMs ?? timestampMs;
  final double lat;
  final double lon;
  final double speed;
  final double accuracy;

  /// When the position was actually sampled (never re-stamped to `now`).
  final int timestampMs;

  /// When the device last proved it is alive (this fix leaving the device).
  /// Equals [timestampMs] for a live fix; `now` for a parked keepalive.
  final int aliveAtMs;

  /// True for a keepalive/floor: the position is [timestampMs] (older) but the
  /// device is alive as of [aliveAtMs].
  final bool parked;
}

enum LocationHealthStatus { idle, acquiring, live, blocked }

enum LocationHealthFailure { permissionDenied, gps, heartbeat }

@immutable
class LocationHealth {
  const LocationHealth({required this.status, this.lastFixAt, this.failure});

  const LocationHealth.idle()
    : status = LocationHealthStatus.idle,
      lastFixAt = null,
      failure = null;

  final LocationHealthStatus status;
  final DateTime? lastFixAt;
  final LocationHealthFailure? failure;
}

/// The concrete battery engine (GO-bar #1/#5/#6). Drives the pure
/// [LocationStateMachine] with real sensors and applies each [EnginePlan]:
///
/// - **Layer 1 (accel wake-gate)** — while idle/sleeping the high-power GPS
///   radio is off; the accelerometer runs and promotes to active on real
///   motion. A cheap LOW-power (fused/network) position stream stays open so
///   the accelerometer path keeps its battery edge over always-on-GPS trackers.
/// - **Adaptive GPS cadence** — the position stream's `distanceFilter`/accuracy
///   are reconfigured from the plan (fast/active/idle).
/// - **Foreground service under Doze (OUR OWN — DEFECT #2)** — a persistent
///   notification + wakelock keeps Android from freezing the isolate. We run our
///   OWN native foreground service ([ForegroundServiceController]), started when
///   sharing begins and kept alive the whole session — NOT geolocator's. This
///   decouples the FGS's lifetime from the GPS stream: geolocator caches its
///   position stream and ignores new `LocationSettings` while a listener is
///   active, so adaptive cadence only takes effect if the stream is fully
///   canceled + reopened (the cache resets on cancel). With our FGS holding the
///   process foreground, that cancel→reopen is safe — it never trips the
///   Android-12 "FGS-with-location can't start from background" block, because
///   ours never stops. geolocator is told NOT to run its own FGS
///   (`foregroundNotificationConfig: null`). Tearing the survival service down
///   when still is exactly what made a backgrounded, stationary phone go dark
///   for hours under Doze (tracker 733): with no service the isolate freezes and
///   every Dart timer / sensor callback stops firing.
/// - **Hard-floor heartbeat (parked keepalive)** — while parked, a periodic
///   tick re-relays presence so a perfectly still device still reports in; it
///   fires only because the foreground service keeps the isolate awake. It
///   carries the REAL last-sample position time plus a separate alive-as-of-now
///   signal (a parked keepalive), so a viewer sees "parked · here since T", not
///   a falsely-fresh "live" — and a genuinely dead phone (no keepalive) darks.
///   It fails toward relaying: on a failed fresh fix it still floors the
///   last-known position rather than going silent.
/// - **Ghost hard-stop** — cancels GPS *and* the foreground service.
///
/// Emits [Fix]es on [fixes]; the relay layer subscribes.
class LocationService {
  LocationService({
    EngineConfig config = const EngineConfig(),
    // 30-minute cheap network heartbeat while parked (idle/parked keepalive —
    // Parker's 1.2.12 decision). A perfectly still device re-relays presence on
    // this floor so it never goes dark, each tick a single low-power (fused) fix
    // — or the last-known position if none can be had — never a GPS lock. The
    // viewer's dark threshold (people_presence.dart `darkAfter`) MUST sit above
    // this with real margin (heartbeat 30m < dark 45m) so a parked-alive phone
    // between keepalives is never mistaken for dead. INVARIANT: heartbeat period
    // strictly < dark threshold. (1.2.10 shipped a ~5-min floor; 1.2.11 a 15-min
    // one — 1.2.12 lands on 30 min with the distinct parked-presence state.)
    this.heartbeat = const Duration(minutes: 30),
    Future<LocationPermission> Function()? checkPermission,
    Future<LocationPermission> Function()? requestPermission,
    Stream<Position> Function(LocationSettings)? positionStream,
    Future<Position> Function(LocationSettings)? currentPosition,
    Stream<AccelerometerEvent> Function()? accelStream,
    ForegroundServiceController? foregroundService,
  }) : _machine = LocationStateMachine(config: config),
       _checkPermission = checkPermission ?? Geolocator.checkPermission,
       _requestPermission = requestPermission ?? Geolocator.requestPermission,
       _positionStream = positionStream ?? _geolocatorStream,
       _currentPosition = currentPosition ?? _geolocatorCurrent,
       _accelStream = accelStream ?? accelerometerEventStream,
       _fgs = foregroundService ?? PlatformForegroundServiceController() {
    // Defect #1-remnant: the FGS's AUTHORITATIVE state is the async
    // startForeground PROMOTION, reported over [ForegroundServiceController.
    // promotions] AFTER start() returns. start()'s bool is only the synchronous
    // accept of the start request; a promotion refusal (the service stops
    // itself) must un-latch the FGS and re-arm, which start() alone can't see.
    _fgsPromotionSub = _fgs.promotions.listen(_onForegroundPromotion);
  }

  static Stream<Position> _geolocatorStream(LocationSettings settings) =>
      Geolocator.getPositionStream(locationSettings: settings);

  static Future<Position> _geolocatorCurrent(LocationSettings settings) =>
      Geolocator.getCurrentPosition(locationSettings: settings);

  final LocationStateMachine _machine;

  // Platform seams, injectable so the acquisition path itself is testable
  // headless (the v1.2 regression shipped because only the pure state machine
  // had coverage — the engine wiring around it did not).
  final Future<LocationPermission> Function() _checkPermission;
  final Future<LocationPermission> Function() _requestPermission;
  final Stream<Position> Function(LocationSettings) _positionStream;
  final Future<Position> Function(LocationSettings) _currentPosition;
  final Stream<AccelerometerEvent> Function() _accelStream;

  /// Our own persistent Android foreground service (DEFECT #2). Started when
  /// sharing begins, stopped only on ghost / dispose — its lifetime is
  /// deliberately decoupled from the GPS stream so cadence can change (cancel +
  /// reopen the geolocator stream) without ever dropping the FGS.
  final ForegroundServiceController _fgs;
  bool _fgsRunning = false;
  // Defect #2-new (R9 headless resume): TRUE when the foreground service is
  // owned by the NATIVE side, not this Dart engine. On the boot/kill-resume path
  // `PointForegroundService` self-promotes the FGS BEFORE launching this
  // headless engine, and the FGS start/stop MethodChannel is registered ONLY in
  // MainActivity's app engine — never here. So this engine must NOT start/stop/
  // retry the FGS over the (unregistered) channel: a start() would throw
  // MissingPluginException → the Defect-#4 confirm-then-retry would arm the 5s
  // re-arm timer FOREVER (it can never succeed), unbounded wakeful churn in the
  // battery-critical resumed state. The native service already holds the process
  // foreground for the whole headless session. See [markForegroundServiceExternallyOwned].
  bool _fgsExternallyOwned = false;
  StreamSubscription<bool>? _fgsPromotionSub;
  // Defect #4: whether the FGS is WANTED (sharing, not ghosted/disposed). The
  // async start/stop path keys on this so a stop that lands while a start is in
  // flight always wins — no orphan FGS left running past a hard stop.
  bool _fgsWanted = false;
  // Defect #4: a start attempt is in flight (awaiting the platform confirm), so
  // a re-entrant _startForegroundService doesn't fire a second one.
  bool _fgsArming = false;
  // Defect #4: re-arm timer. A refused native FGS start (Android 12+ can refuse
  // a foreground-service-with-location start from the background) must not leave
  // us believing the survival service is up — we retry instead of latching.
  Timer? _fgsRetryTimer;
  static const _fgsRetryBackoff = Duration(seconds: 5);

  /// The hard floor while stationary (idle/sleeping): the high-power GPS radio
  /// is off, but on this cadence the engine re-relays a fix (a cheap fused/
  /// network sample, or the last-known position if none can be had) so a viewer
  /// still sees "at home" and the phone never goes dark while parked. GPS bursts
  /// only when actually moving (the win over always-poll trackers).
  final Duration heartbeat;

  final _fixes = StreamController<Fix>.broadcast();
  Stream<Fix> get fixes => _fixes.stream;
  final _health = StreamController<LocationHealth>.broadcast();
  LocationHealth _currentHealth = const LocationHealth.idle();
  LocationHealth get currentHealth => _currentHealth;
  Stream<LocationHealth> get health => _health.stream;

  StreamSubscription<Position>? _gpsSub;
  StreamSubscription<AccelerometerEvent>? _accelSub;
  Timer? _stillnessTimer;
  Timer? _heartbeatTimer;

  // GPS self-heal (R4): a subscription that errors out must not latch dark. We
  // clear the applied plan (so the next _apply reopens a fresh stream) and, if
  // nothing else drives an _apply, a backed-off timer re-arms. A fresh fix
  // resets the backoff and cancels the pending retry.
  Timer? _gpsRetryTimer;
  static const _gpsRetryBase = Duration(seconds: 5);
  static const _gpsRetryMax = Duration(minutes: 2);
  Duration _gpsRetryBackoff = _gpsRetryBase;
  LocationActivity _appliedActivity = LocationActivity.idle;

  // The EFFECTIVE geolocator settings currently applied — accuracy, distance
  // filter, and interval, i.e. exactly what reaches the platform. R15: keying
  // the reopen guard on this (not the whole plan / the activity) means an
  // active↔fast flip in the foreground — same 2s/0m/high settings — does NOT
  // reopen the GPS stream and thrash the radio at every city stop-and-go.
  _GpsKey? _appliedGpsKey;
  Fix? _lastFix;

  // R14: the Layer-1 accel wake threshold, in m/s² of LINEAR acceleration over
  // the gravity baseline. The old gate mixed units — it compared a SQUARED
  // magnitude (|a|² − g²) against a linear threshold (1.2·g), so it fired at
  // ~0.6 m/s² collinear (2× too twitchy — a buzzing desk woke GPS) yet needed
  // ~3.43 m/s² of pure lateral (under-detecting smooth car accel). Now the
  // magnitude is linear (|a| − g) and compared against a linear threshold, so
  // it's a consistent ~1.2 m/s² in every direction (the documented value).
  static const _motionThreshold = 1.2; // m/s^2 over gravity baseline

  // Stillness ramp-down (location-strategy.html ACTIVE→SLEEPING: "No move 30s
  // (bg) / 2min (fg)"): how long without movement before GPS backs off. The
  // background kills fast (Doze is near); the foreground lingers so a brief
  // pause while looking at the map doesn't drop the live cadence.
  static const _stillnessForeground = Duration(minutes: 2);
  static const _stillnessBackground = Duration(seconds: 30);

  // Layer-1 wake hysteresis (location-strategy.html: "10s sustained movement
  // before waking GPS ... prevents thrashing"). A single bump / pocket jitter
  // must NOT wake the radio — only ~10s of sustained motion does. Timer-based
  // so a still gap (no motion sample for _motionGraceGap) resets the accrual.
  static const _motionWakeSustained = Duration(seconds: 10);
  static const _motionGraceGap = Duration(seconds: 2);
  Timer? _motionWakeTimer;
  Timer? _motionGapTimer;

  LocationActivity get activity => _machine.activity;
  EnginePlan get plan => _machine.plan;

  Future<bool> ensurePermission() async {
    var perm = await _checkPermission();
    if (perm == LocationPermission.denied) {
      perm = await _requestPermission();
    }
    return perm == LocationPermission.always ||
        perm == LocationPermission.whileInUse;
  }

  bool _started = false;

  /// Start the engine (idempotent — safe to call on every sign-in). Requests
  /// location permission once, then runs the plan. Starting with the app open
  /// behaves like a foreground resume: jump to active for a prompt first fix
  /// (the map's initial centering and self-marker hang off it) instead of
  /// waiting out motion or the first heartbeat.
  Future<void> start() async {
    if (!_started) {
      if (!await ensurePermission()) {
        _emitHealth(
          const LocationHealth(
            status: LocationHealthStatus.blocked,
            failure: LocationHealthFailure.permissionDenied,
          ),
        );
        return;
      }
      _started = true;
    }
    _emitHealth(
      LocationHealth(
        status: LocationHealthStatus.acquiring,
        lastFixAt: _currentHealth.lastFixAt,
      ),
    );
    if (_machine.foreground) _machine.onForeground();
    _apply();
  }

  void onForeground() {
    _machine.onForeground();
    _apply();
  }

  void onBackground() {
    _machine.onBackground();
    _apply();
  }

  /// Ghost toggle (GO-bar #6): a hard stop, not just relay suppression.
  void setSharing({required bool sharing}) {
    _machine.setSharing(sharing: sharing);
    _apply();
  }

  // --- Layer-4 watcher-wake --------------------------------------------------

  bool _wakeInFlight = false;
  DateTime? _lastWakeAt;

  /// Coalesce window for demand wakes: a burst of watchers (or WS nudges) can't
  /// drive more than one out-of-band fix per this interval. The server already
  /// dedupes OFFLINE push wakes to ~1/15s per person; this is the on-device
  /// guard for the ONLINE (WS-forwarded) path, where several viewers each relay
  /// a nudge.
  static const _wakeMinInterval = Duration(seconds: 10);

  /// A watcher opened this device's live view (Layer 4, demand-driven). Acquire
  /// ONE fix out-of-band and relay it through the normal [fixes] path, WITHOUT
  /// moving the state machine — so the engine returns to its prior sleep/parked
  /// state on its own (there is no activity change to undo). Works from the
  /// background: it reuses the same low-cost one-shot seam the parked keepalive
  /// uses, kept alive by the foreground service.
  ///
  /// Respects sharing END-TO-END: a hard stop (ghost) or a not-yet-started
  /// engine makes this a no-op — `plan.gpsEnabled` is false in ghost — so a
  /// watcher can never wake a device that went dark, even if a wake slips
  /// through. Coalesced (one in flight) and throttled ([_wakeMinInterval]).
  Future<void> wakeForOneFix() async {
    // Respect ghost / pre-permission: never sample when sharing is stopped.
    if (!_started || !_machine.plan.gpsEnabled) return;
    if (_wakeInFlight) return;
    final now = DateTime.now();
    final last = _lastWakeAt;
    if (last != null && now.difference(last) < _wakeMinInterval) return;
    _wakeInFlight = true;
    _lastWakeAt = now;
    try {
      Position? p;
      try {
        p = await _currentPosition(
          const LocationSettings(
            // A demand fix wants a real, fresh position (the viewer is looking
            // now), not the low-power keepalive sample.
            accuracy: LocationAccuracy.high,
            timeLimit: Duration(seconds: 20),
          ),
        );
      } on Object catch (e) {
        if (kDebugMode) debugPrint('watcher-wake fix error: $e');
      }
      // Ghost/dispose can land while the fix is in flight — never leak a fix
      // past a go-dark (mirrors the heartbeat guard).
      if (!_started || !_machine.plan.gpsEnabled) return;
      if (p != null) {
        _emit(p);
      } else {
        // No fresh fix (indoors / throttled provider): re-relay the last-known
        // floor so the watcher still sees presence instead of a dark marker.
        _emitFloor();
      }
    } finally {
      _wakeInFlight = false;
    }
  }

  // --- engine application --------------------------------------------------

  /// Reconcile real sensors with the current [EnginePlan].
  void _apply() {
    // Before start() clears the permission gate, lifecycle/sharing events may
    // only update the machine — never touch the sensors (a pre-grant apply
    // would poke the location plugin before onboarding has earned the ask).
    if (!_started) return;
    final plan = _machine.plan;

    if (!plan.gpsEnabled) {
      // Ghost / hard stop: everything off (including any pending GPS re-arm —
      // a hard stop must not self-heal back into broadcasting) AND our own
      // foreground service (DEFECT #2): ghost is the one place the FGS drops.
      _stopGps();
      _stopAccel();
      _stopForegroundService();
      _gpsRetryTimer?.cancel();
      _gpsRetryTimer = null;
      _stillnessTimer?.cancel();
      _heartbeatTimer?.cancel();
      _heartbeatTimer = null;
      _appliedActivity = plan.activity;
      _emitHealth(
        LocationHealth(
          status: LocationHealthStatus.idle,
          lastFixAt: _currentHealth.lastFixAt,
        ),
      );
      return;
    }

    // DEFECT #2: our own foreground service runs the WHOLE time we're sharing —
    // started here (idempotent), before any GPS stream opens, so the process is
    // foreground-promoted and geolocator's stream can be canceled + reopened to
    // change cadence without ever tripping the Android-12 background FGS block.
    _startForegroundService();

    // R8: the parked keepalive heartbeat is a hard floor that must keep running
    // regardless of activity. The old engine canceled it on every foreground
    // (active/fast) transition, so a person indoors with no GPS fix who keeps
    // reopening the app was left unboundedly dark — each reopen jumped to active
    // and killed the only floor. Start it unconditionally (idempotent); only
    // ghost / dispose stop it.
    _startHeartbeat();

    switch (plan.activity) {
      case LocationActivity.idle:
      case LocationActivity.sleeping:
        // Parked: the accelerometer promotes to active on real motion, and a
        // periodic hard-floor heartbeat re-relays presence while perfectly
        // still. Our own foreground service (started above) + its wakelock is
        // what stops Android Doze from freezing the isolate — NOT the position
        // stream (DEFECT #2 decoupled them). We still keep a low-power
        // (fused/network) stream open as a cheap movement signal; it is low
        // accuracy + a wide distanceFilter, so the GPS radio stays effectively
        // off. Stopping the FGS while still — as the engine used to, by tearing
        // down geolocator's stream-bound service — froze the heartbeat timer and
        // the accelerometer and the phone went dark for hours (tracker 733).
        final enteringParked =
            _appliedActivity != LocationActivity.idle &&
            _appliedActivity != LocationActivity.sleeping;
        _startAccel();
        _startGps(plan);
        // R16: keep ramping DOWN while parked. Idle must re-arm the stillness
        // window so it demotes idle → sleeping (30s poll → 60s), instead of
        // getting stuck in IDLE forever (2× the parked wakes). Only idle arms it
        // (sleeping is the floor — arming there would just churn a timer that
        // can't demote further).
        if (plan.activity == LocationActivity.idle &&
            _stillnessTimer?.isActive != true) {
          _armStillness();
        }
        // R7: close the initial dark gap. The moment we park, relay a keepalive
        // NOW rather than waiting out the first 30-minute heartbeat — otherwise
        // a device that just went still is briefly indistinguishable from dead.
        if (enteringParked && _lastFix != null) _emitFloor();
      case LocationActivity.active:
      case LocationActivity.fast:
      case LocationActivity.ghost:
        // Moving: accelerometer off (motion is obvious), GPS on at the plan's
        // cadence. The heartbeat floor stays running (R8) — started above.
        _stopAccel();
        _startGps(plan);
        // Acquisition bound: a GPS that cannot fix (indoors, stalled
        // provider) must not pin high-power active forever — with no fix to
        // re-arm the stillness window, ramp down and let the heartbeat /
        // motion wake carry it (v1.2.1 review).
        if (_stillnessTimer?.isActive != true) _armStillness();
    }
    _appliedActivity = plan.activity;
  }

  /// DEFECT #2 — CANCEL-THEN-REOPEN. geolocator caches its position stream and
  /// IGNORES new LocationSettings while a listener is active
  /// (geolocator_android: `if (_positionStream != null) return _positionStream!`),
  /// so to change cadence we must fully cancel — drop to zero listeners, which
  /// synchronously resets its cache
  /// (`asBroadcastStream(onCancel: () => _positionStream = null)`; a stream
  /// controller's onCancel runs synchronously) — and THEN reopen with the new
  /// settings. Because the cache reset is synchronous, we cancel and reopen in
  /// one synchronous step: no listener gap where an incoming fix could be lost,
  /// and the reopen is guaranteed to build a fresh stream honoring the new
  /// settings. Our own foreground service keeps the process foreground-promoted
  /// throughout, so this cancel→reopen never trips the Android-12
  /// "FGS-with-location can't start from background" block that once forced a
  /// make-before-break. (Make-before-break was the battery-drain half of the
  /// bug: it never dropped to zero listeners, so geolocator handed back the
  /// cached stream and the OLD cadence — adaptive cadence silently froze after
  /// the first fix.)
  void _startGps(EnginePlan plan) {
    final key = _gpsKey(plan);
    // R15: the effective settings already applied — same accuracy, distance
    // filter, and interval — so there is nothing to change. Don't reopen an
    // identical stream (an active↔fast flip in the foreground is the same
    // 2s/0m/high stream) and thrash the GPS radio at every city stop-and-go.
    if (_gpsSub != null && _appliedGpsKey == key) return;
    final previous = _gpsSub;
    _appliedGpsKey = key;
    final settings = _androidSettings(plan);
    // Cancel FIRST (synchronously resets geolocator's settings cache), then open
    // the replacement in the same tick.
    unawaited(previous?.cancel());
    _gpsSub = _positionStream(settings).listen(
      _onPosition,
      onError: (Object e) {
        _emitHealth(
          LocationHealth(
            status: LocationHealthStatus.blocked,
            lastFixAt: _currentHealth.lastFixAt,
            failure: LocationHealthFailure.gps,
          ),
        );
        // R4 — self-heal. Don't latch dark on a dead subscription. Clearing the
        // applied key defeats the no-op guard so the next _apply reopens a fresh
        // stream, and a backed-off timer re-arms if nothing else triggers an
        // _apply. The erroring subscription is left in place so a stream that
        // merely hiccuped still delivers its next value; the reopen replaces a
        // truly-dead one.
        _appliedGpsKey = null;
        _scheduleGpsRetry();
        if (kDebugMode) debugPrint('gps error: $e');
      },
    );
  }

  _GpsKey _gpsKey(EnginePlan plan) {
    final moving =
        plan.activity == LocationActivity.fast ||
        plan.activity == LocationActivity.active;
    return (
      // Parked = LOW power (fused/cell-wifi); moving = high accuracy. Same
      // derivation as _androidSettings, so the key tracks what geolocator gets.
      accuracy: moving ? LocationAccuracy.high : LocationAccuracy.low,
      distanceFilter: plan.distanceFilter,
      intervalMs: plan.gpsInterval.inMilliseconds,
    );
  }

  /// R9 headless resume (Defect #2-new): mark the foreground service as owned by
  /// the native service. Call BEFORE [start] on the boot/kill-resume headless
  /// engine so this engine never starts/stops/retries its own FGS over a channel
  /// that is not registered here — the native service already holds the process
  /// foreground. See [_fgsExternallyOwned].
  void markForegroundServiceExternallyOwned() {
    _fgsExternallyOwned = true;
  }

  void _startForegroundService() {
    // Defect #2-new: on the R9 headless resume the native service owns the FGS;
    // don't start/retry it over the (unregistered) channel — a start() would
    // throw MissingPluginException and the Defect-#4 retry would then spin the
    // 5s re-arm timer forever. The native side already holds the foreground.
    if (_fgsExternallyOwned) return;
    // Defect #4: do NOT latch `_fgsRunning = true` before the async start — the
    // native start can be refused (Android 12+ background FGS-with-location
    // block) and latching optimistically left us believing our survival service
    // held the process foreground when it did not, a Doze go-dark. Confirm the
    // platform actually started it, then latch; retry on refusal.
    _fgsWanted = true;
    if (_fgsRunning || _fgsArming) return;
    _fgsArming = true;
    unawaited(_armForegroundService());
  }

  Future<void> _armForegroundService() async {
    var started = false;
    try {
      started = await _fgs.start();
    } finally {
      _fgsArming = false;
    }
    // A stop (ghost/dispose) may have landed while the start was in flight — the
    // hard stop must win, so undo a start that confirmed too late rather than
    // leaving an orphan FGS running.
    if (!_fgsWanted) {
      if (started) unawaited(_fgs.stop());
      _fgsRunning = false;
      return;
    }
    if (started) {
      _fgsRunning = true;
      _fgsRetryTimer?.cancel();
      _fgsRetryTimer = null;
      return;
    }
    // Refused — re-arm with a fixed backoff so we recover when the OS next
    // allows the start (e.g. the app returns to the foreground), instead of
    // going dark under Doze with no foreground service.
    _fgsRetryTimer?.cancel();
    _fgsRetryTimer = Timer(_fgsRetryBackoff, _startForegroundService);
  }

  /// Defect #1-remnant: the AUTHORITATIVE FGS result, delivered after start()
  /// returns. start()'s bool only reported that the OS ACCEPTED the start
  /// request; the process is truly foreground-promoted only when the native
  /// `startForeground` succeeds (async, in the service's onStartCommand). A
  /// refusal there stops the service — the FGS is DOWN while start() said "ok" —
  /// so un-latch and re-arm instead of believing a dead survival service is up.
  void _onForegroundPromotion(bool promoted) {
    // Native owns the FGS on the headless resume — nothing to track here.
    if (_fgsExternallyOwned) return;
    // A stop (ghost/dispose) already won — don't resurrect the FGS.
    if (!_fgsWanted) return;
    if (promoted) {
      // Confirmed foreground-promoted: latch and drop any pending re-arm.
      _fgsRunning = true;
      _fgsRetryTimer?.cancel();
      _fgsRetryTimer = null;
      return;
    }
    // Promotion refused (usually a missing FOREGROUND_SERVICE_LOCATION/location
    // permission a retry can't fix, but also a transient background-start window
    // that reopening the app clears). Don't latch a dead FGS — re-arm, mirroring
    // the Defect-#4 accept-refusal path.
    _fgsRunning = false;
    _fgsRetryTimer?.cancel();
    _fgsRetryTimer = Timer(_fgsRetryBackoff, _startForegroundService);
  }

  void _stopForegroundService() {
    // Native owns the FGS lifecycle on the headless resume — don't touch it (the
    // stop channel isn't registered here anyway). Defect #2-new.
    if (_fgsExternallyOwned) return;
    _fgsWanted = false;
    _fgsRetryTimer?.cancel();
    _fgsRetryTimer = null;
    if (!_fgsRunning) return;
    _fgsRunning = false;
    unawaited(_fgs.stop());
  }

  /// R4 — re-arm GPS after an error with exponential backoff, so a dead
  /// subscription recovers on its own instead of leaving the device dark.
  /// Foreground/connectivity changes also re-arm (they call [_apply]).
  void _scheduleGpsRetry() {
    _gpsRetryTimer?.cancel();
    _gpsRetryTimer = Timer(_gpsRetryBackoff, () {
      _gpsRetryTimer = null;
      _gpsRetryBackoff = Duration(
        milliseconds: (_gpsRetryBackoff.inMilliseconds * 2).clamp(
          _gpsRetryBase.inMilliseconds,
          _gpsRetryMax.inMilliseconds,
        ),
      );
      if (_started && _machine.plan.gpsEnabled) _apply();
    });
  }

  LocationSettings _androidSettings(EnginePlan plan) {
    final moving =
        plan.activity == LocationActivity.fast ||
        plan.activity == LocationActivity.active;
    // The plan owns the distance filter (the battery lever): 0m every-fix in
    // the foreground, wider in the background / while parked (Layer 3 tables).
    final distanceFilter = plan.distanceFilter;
    return AndroidSettings(
      // Parked = LOW power (fused/cell-wifi, PRIORITY_LOW_POWER): this stream
      // exists as a low-cost movement/keepalive signal, not to burn the GPS
      // radio. Moving = high accuracy for a real track.
      accuracy: moving ? LocationAccuracy.high : LocationAccuracy.low,
      distanceFilter: distanceFilter,
      intervalDuration: plan.gpsInterval,
      // DEFECT #2: geolocator runs NO foreground service of its own — we leave
      // `foregroundNotificationConfig` at its null default. WE run our own
      // persistent FGS ([ForegroundServiceController]) that survives background
      // + Doze, so its lifetime is decoupled from this stream: the stream can be
      // canceled + reopened to change cadence without the Android-12 background
      // FGS-start block. If geolocator kept its FGS, the cancel needed to defeat
      // its settings cache would tear that FGS down and the reopen would be
      // blocked from background.
    );
  }

  void _onPosition(Position p) {
    final fix = Fix(
      lat: p.latitude,
      lon: p.longitude,
      speed: p.speed,
      accuracy: p.accuracy,
      timestampMs: p.timestamp.millisecondsSinceEpoch,
    );
    final moved = _lastFix == null
        ? double.infinity
        : Geolocator.distanceBetween(
            _lastFix!.lat,
            _lastFix!.lon,
            fix.lat,
            fix.lon,
          );
    _lastFix = fix;
    // A live fix proves the subscription is healthy: cancel any pending re-arm
    // and reset the backoff (R4).
    _gpsRetryTimer?.cancel();
    _gpsRetryTimer = null;
    _gpsRetryBackoff = _gpsRetryBase;
    _emitHealth(
      LocationHealth(status: LocationHealthStatus.live, lastFixAt: p.timestamp),
    );
    _machine.onGpsFix(speed: p.speed, movedMetres: moved);
    _fixes.add(fix);
    _armStillness();
    // Cadence may have changed (active↔fast) — reconcile, but DEFER it off this
    // position-stream callback's firing stack (Defect #1). _apply → _startGps
    // cancels the current stream and reopens with the new cadence, relying on
    // geolocator's onCancel resetting its settings cache SYNCHRONOUSLY so the
    // reopen builds a fresh stream. That holds for lifecycle-driven reopens, but
    // NOT here: cancelling a broadcast subscription from WITHIN its own event
    // dispatch makes Dart defer onCancel until firing ends, so the cache would
    // still be set and the reopen would hand back the STALE cached stream (old
    // cadence — e.g. background active→fast >5 m/s stuck at 15s/10m instead of
    // 10s/25m). scheduleMicrotask runs the reconcile after this dispatch
    // unwinds, when the cancel takes effect synchronously and the reopen is
    // honored. Re-check under the fresh machine state — another event may have
    // already reconciled by the time the microtask runs.
    if (_machine.activity != _appliedActivity) {
      scheduleMicrotask(() {
        if (_started &&
            _machine.plan.gpsEnabled &&
            _machine.activity != _appliedActivity) {
          _apply();
        }
      });
    }
  }

  void _startAccel() {
    if (_accelSub != null) return;
    _accelSub = _accelStream().listen((e) {
      // Magnitude minus gravity ~ motion. Only SUSTAINED motion wakes GPS (the
      // Layer-1 hysteresis); a lone bump is ignored so we don't thrash the
      // radio. This runs in the background too — the foreground service keeps
      // the isolate awake, so the accelerometer keeps gating GPS while parked
      // and backgrounded (before the FGS-survival fix the isolate froze here
      // and background motion detection died).
      // R14: LINEAR acceleration magnitude minus gravity, in m/s² — the same
      // unit as the threshold, so the gate is a consistent ~1.2 m/s² in every
      // direction. (The old gate compared a SQUARED magnitude, |a|²−g², against
      // a linear 1.2·g, mixing units: it fired at ~0.6 m/s² collinear — a
      // buzzing desk — yet needed ~3.43 m/s² of pure lateral, under-detecting
      // smooth car acceleration.)
      final magnitude =
          math.sqrt(e.x * e.x + e.y * e.y + e.z * e.z) - 9.81;
      if (magnitude.abs() > _motionThreshold) _onMotionSample();
    });
  }

  /// One above-threshold accelerometer sample. Wakes GPS only once motion has
  /// been sustained for [_motionWakeSustained]; a still gap longer than
  /// [_motionGraceGap] (no motion sample) resets the accrual. Purely
  /// timer-driven so it's testable headless and needs no wall clock.
  void _onMotionSample() {
    // Keep the sustained-motion window alive: any real still gap cancels it.
    _motionGapTimer?.cancel();
    _motionGapTimer = Timer(_motionGraceGap, _resetMotionAccrual);
    // Start counting toward the wake, once, from the first sample of a burst.
    _motionWakeTimer ??= Timer(_motionWakeSustained, () {
      _resetMotionAccrual();
      _machine.onMovementWake();
      if (_machine.activity != _appliedActivity) _apply();
    });
  }

  void _resetMotionAccrual() {
    _motionWakeTimer?.cancel();
    _motionWakeTimer = null;
    _motionGapTimer?.cancel();
    _motionGapTimer = null;
  }

  void _armStillness() {
    _stillnessTimer?.cancel();
    final window =
        _machine.foreground ? _stillnessForeground : _stillnessBackground;
    _stillnessTimer = Timer(window, () {
      _machine.onStillness();
      _apply();
    });
  }

  void _startHeartbeat() {
    if (_heartbeatTimer != null) return;
    _heartbeatTimer = Timer.periodic(heartbeat, (timer) async {
      // Cheap fix while parked: low accuracy uses network/fused, not the GPS
      // radio, so it costs a fraction of a real GPS lock.
      Position? p;
      try {
        p = await _currentPosition(
          const LocationSettings(
            accuracy: LocationAccuracy.low,
            // Fail fast instead of spinning if a fix can't be had (measured:
            // an unbounded request burns CPU when location is unavailable).
            timeLimit: Duration(seconds: 20),
          ),
        );
      } on Object catch (e) {
        // Swallow — the floor below still relays. A failed fresh fix (indoors,
        // a Doze-throttled provider) must NOT be the thing that goes dark.
        if (kDebugMode) debugPrint('heartbeat fix error: $e');
      }
      // Ghost (or dispose) can land while the request is in flight, and a hard
      // stop only cancels FUTURE ticks — nothing must leak out past go-dark
      // (safety-critical; v1.2.1 review).
      if (!timer.isActive || !_machine.plan.gpsEnabled) return;
      if (p != null) {
        _emit(p);
        return;
      }
      // Hard floor: no fresh fix, but re-relay the LAST-KNOWN position with a
      // current timestamp so a still, backgrounded phone still reports presence
      // instead of going dark. Sent directly through [fixes], never buffered.
      _emitFloor();
    });
  }

  /// Parked keepalive: re-relay the last-KNOWN position so a still device stays
  /// visible, but carry the REAL last-sample time as [Fix.timestampMs] and only
  /// stamp `now` onto the SEPARATE liveness clock ([Fix.aliveAtMs]), flagged
  /// [Fix.parked]. This is the 1.2.11 go-dark fix: the old floor re-stamped the
  /// POSITION time to `now`, which made a dead phone look "live, at home" and,
  /// worse, meant a genuinely dead device could not be told apart from a parked
  /// one. Now the viewer reads the two clocks: recent liveness + older position
  /// ⇒ "parked · here since T"; no liveness past the dark threshold ⇒ dark.
  /// With no fix ever taken yet there is nothing to floor on — surface a
  /// degraded heartbeat instead.
  void _emitFloor() {
    final last = _lastFix;
    if (last == null) {
      _emitHealth(
        LocationHealth(
          status: LocationHealthStatus.blocked,
          lastFixAt: _currentHealth.lastFixAt,
          failure: LocationHealthFailure.heartbeat,
        ),
      );
      return;
    }
    final now = DateTime.now();
    final fix = Fix(
      lat: last.lat,
      lon: last.lon,
      speed: 0,
      accuracy: last.accuracy,
      // REAL sample time — never re-stamped to now.
      timestampMs: last.timestampMs,
      // Alive as of now (the keepalive's departure), driving alive/dark.
      aliveAtMs: now.millisecondsSinceEpoch,
      parked: true,
    );
    _lastFix = fix;
    _emitHealth(
      LocationHealth(status: LocationHealthStatus.live, lastFixAt: now),
    );
    _fixes.add(fix);
  }

  void _emit(Position p) {
    final fix = Fix(
      lat: p.latitude,
      lon: p.longitude,
      speed: p.speed,
      accuracy: p.accuracy,
      timestampMs: p.timestamp.millisecondsSinceEpoch,
    );
    _lastFix = fix;
    _emitHealth(
      LocationHealth(status: LocationHealthStatus.live, lastFixAt: p.timestamp),
    );
    _fixes.add(fix);
  }

  void _stopGps() {
    unawaited(_gpsSub?.cancel());
    _gpsSub = null;
    _appliedGpsKey = null;
  }

  void _stopAccel() {
    unawaited(_accelSub?.cancel());
    _accelSub = null;
    _resetMotionAccrual();
  }

  Future<void> dispose() async {
    await _stopGpsAsync();
    await _accelSub?.cancel();
    _resetMotionAccrual();
    _stopForegroundService();
    await _fgsPromotionSub?.cancel();
    _gpsRetryTimer?.cancel();
    _stillnessTimer?.cancel();
    _heartbeatTimer?.cancel();
    await _fixes.close();
    await _health.close();
  }

  void _emitHealth(LocationHealth health) {
    _currentHealth = health;
    if (!_health.isClosed) _health.add(health);
  }

  Future<void> _stopGpsAsync() async {
    await _gpsSub?.cancel();
    _gpsSub = null;
  }
}
