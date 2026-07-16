import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:geolocator/geolocator.dart';
import 'package:point_app/features/location/domain/location_state_machine.dart';
import 'package:sensors_plus/sensors_plus.dart';

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
/// - **Foreground service under Doze** — a persistent notification + wakelock
///   keeps Android from freezing the isolate. Geolocator only runs that service
///   while a position stream is open, so the engine keeps a low-power stream
///   alive even while parked. Tearing it down when still is exactly what made a
///   backgrounded, stationary phone go dark for hours under Doze (tracker 733):
///   with no service the isolate freezes and every Dart timer / sensor callback
///   stops firing.
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
  }) : _machine = LocationStateMachine(config: config),
       _checkPermission = checkPermission ?? Geolocator.checkPermission,
       _requestPermission = requestPermission ?? Geolocator.requestPermission,
       _positionStream = positionStream ?? _geolocatorStream,
       _currentPosition = currentPosition ?? _geolocatorCurrent,
       _accelStream = accelStream ?? accelerometerEventStream;

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
  EnginePlan? _appliedGpsPlan;
  Fix? _lastFix;

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
      // a hard stop must not self-heal back into broadcasting).
      _stopGps();
      _stopAccel();
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

    switch (plan.activity) {
      case LocationActivity.idle:
      case LocationActivity.sleeping:
        // Parked: the accelerometer promotes to active on real motion, and a
        // periodic hard-floor heartbeat re-relays presence while perfectly
        // still. Crucially we KEEP a low-power (fused/network) position stream
        // open — geolocator only runs the Android foreground service while a
        // stream is live, and that service (+ wakelock) is the only thing that
        // stops Android Doze from freezing the isolate. Stopping GPS here — as
        // the engine used to — killed the service, froze the heartbeat timer
        // and the accelerometer, and the phone went dark for hours (tracker
        // 733). The stream is low accuracy + a wide distanceFilter, so the GPS
        // radio stays effectively off; it is the FGS keep-alive, not a GPS burst.
        final enteringParked =
            _appliedActivity != LocationActivity.idle &&
            _appliedActivity != LocationActivity.sleeping;
        _startAccel();
        _startGps(plan);
        _startHeartbeat();
        // R7: close the initial dark gap. The moment we park, relay a keepalive
        // NOW rather than waiting out the first 30-minute heartbeat — otherwise
        // a device that just went still is briefly indistinguishable from dead.
        if (enteringParked && _lastFix != null) _emitFloor();
      case LocationActivity.active:
      case LocationActivity.fast:
      case LocationActivity.ghost:
        // Moving: accelerometer + heartbeat off, GPS on at the plan's cadence.
        _stopAccel();
        _stopHeartbeat();
        _startGps(plan);
        // Acquisition bound: a GPS that cannot fix (indoors, stalled
        // provider) must not pin high-power active forever — with no fix to
        // re-arm the stillness window, ramp down and let the heartbeat /
        // motion wake carry it (v1.2.1 review).
        if (_stillnessTimer?.isActive != true) _armStillness();
    }
    _appliedActivity = plan.activity;
  }

  void _startGps(EnginePlan plan) {
    // Reconfigure when the effective GPS plan changed — NOT just the activity.
    // Foreground↔background keeps the activity `active` but changes the interval
    // (2s ↔ 12s), so we must reopen the stream on an interval/accuracy change or
    // the background cadence never takes effect.
    if (_gpsSub != null && _appliedGpsPlan == plan) return;
    // R3/R4 — MAKE-BEFORE-BREAK. The old engine `_stopGps()`'d here, then
    // re-listened: that tears down the running foreground service, and on
    // Android 12+ a *new* foreground-service-with-location cannot be started
    // FROM BACKGROUND — so a parked→active wake in the background killed the
    // FGS and the phone went dark for hours. Instead we open the replacement
    // stream FIRST (the process is already foreground-promoted by the live FGS,
    // so its FGS start is allowed), then cancel the previous one — the survival
    // service never has a gap.
    final previous = _gpsSub;
    _appliedGpsPlan = plan;
    final settings = _androidSettings(plan);
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
        // applied plan defeats the no-op guard so the next _apply reopens a
        // fresh stream (make-before-break), and a backed-off timer re-arms in
        // case nothing else triggers an _apply. The erroring subscription is
        // left in place so a stream that merely hiccuped still delivers its next
        // value; the reopen replaces a truly-dead one.
        _appliedGpsPlan = null;
        _scheduleGpsRetry();
        if (kDebugMode) debugPrint('gps error: $e');
      },
    );
    // Cancel the previous survival stream only AFTER the replacement is
    // subscribed (never before its replacement is up).
    unawaited(previous?.cancel());
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
      // exists to keep the foreground service alive under Doze, not to burn the
      // GPS radio. Moving = high accuracy for a real track.
      accuracy: moving ? LocationAccuracy.high : LocationAccuracy.low,
      distanceFilter: distanceFilter,
      intervalDuration: plan.gpsInterval,
      // The foreground service is what survives background + doze; only shown
      // while actively sharing (plan.foregroundService).
      foregroundNotificationConfig: plan.foregroundService
          ? const ForegroundNotificationConfig(
              notificationTitle: 'Point',
              notificationText: 'Sharing your location',
              enableWakeLock: true,
              notificationIcon: AndroidResource(name: 'ic_launcher'),
            )
          : null,
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
    // Cadence may have changed (active↔fast) — reconcile.
    if (_machine.activity != _appliedActivity) _apply();
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
      final magnitude = (e.x * e.x + e.y * e.y + e.z * e.z) - (9.81 * 9.81);
      if (magnitude.abs() > _motionThreshold * 9.81) _onMotionSample();
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

  void _stopHeartbeat() {
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
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
    _appliedGpsPlan = null;
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
