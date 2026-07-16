import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:geolocator/geolocator.dart';
import 'package:point_app/features/location/domain/location_state_machine.dart';
import 'package:sensors_plus/sensors_plus.dart';

/// A location fix ready for the relay (still plaintext here — encryption happens
/// in the crypto/relay layer before it leaves the device).
class Fix {
  const Fix({
    required this.lat,
    required this.lon,
    required this.speed,
    required this.accuracy,
    required this.timestampMs,
  });
  final double lat;
  final double lon;
  final double speed;
  final double accuracy;
  final int timestampMs;
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
/// - **Hard-floor heartbeat** — while parked, a periodic tick re-relays the
///   last-known position (with a fresh timestamp) so a perfectly still device
///   still reports presence; it fires only because the foreground service keeps
///   the isolate awake. It fails toward relaying: on a failed fresh fix it still
///   floors the last-known position rather than going silent.
/// - **Ghost hard-stop** — cancels GPS *and* the foreground service.
///
/// Emits [Fix]es on [fixes]; the relay layer subscribes.
class LocationService {
  LocationService({
    EngineConfig config = const EngineConfig(),
    // ~5-minute hard floor: how often a parked device re-relays presence so it
    // never goes dark while still. Short enough to stay "live" to viewers,
    // cheap because it's a single low-power (fused) fix, not a GPS lock.
    this.heartbeat = const Duration(minutes: 5),
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
  LocationActivity _appliedActivity = LocationActivity.idle;
  EnginePlan? _appliedGpsPlan;
  Fix? _lastFix;

  static const _motionThreshold = 1.2; // m/s^2 over gravity baseline
  static const _stillnessBackground = Duration(seconds: 30);

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
      // Ghost / hard stop: everything off.
      _stopGps();
      _stopAccel();
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
        _startAccel();
        _startGps(plan);
        _startHeartbeat();
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
    _stopGps();
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
        if (kDebugMode) debugPrint('gps error: $e');
      },
    );
  }

  LocationSettings _androidSettings(EnginePlan plan) {
    final moving =
        plan.activity == LocationActivity.fast ||
        plan.activity == LocationActivity.active;
    // distanceFilter is the battery lever: only emit after real movement.
    final distanceFilter = switch (plan.activity) {
      LocationActivity.fast => 10,
      LocationActivity.active => 5,
      _ => 50,
    };
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
      // Magnitude minus gravity ~ motion. A sustained bump wakes GPS.
      final magnitude = (e.x * e.x + e.y * e.y + e.z * e.z) - (9.81 * 9.81);
      if (magnitude.abs() > _motionThreshold * 9.81) {
        _machine.onMovementWake();
        if (_machine.activity != _appliedActivity) _apply();
      }
    });
  }

  void _armStillness() {
    _stillnessTimer?.cancel();
    _stillnessTimer = Timer(_stillnessBackground, () {
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

  /// Re-relay the last-known position stamped `now` so a parked device stays
  /// visible even when no fresh fix can be acquired. With no fix ever taken yet
  /// there is nothing to floor on — surface a degraded heartbeat instead.
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
      timestampMs: now.millisecondsSinceEpoch,
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
  }

  Future<void> dispose() async {
    await _stopGpsAsync();
    await _accelSub?.cancel();
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
