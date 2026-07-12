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

/// The concrete battery engine (GO-bar #1/#5/#6). Drives the pure
/// [LocationStateMachine] with real sensors and applies each [EnginePlan]:
///
/// - **Layer 1 (accel wake-gate)** — while idle/sleeping the GPS radio is OFF
///   and only the accelerometer runs; motion re-arms GPS. This is the primary
///   battery win over always-on-GPS trackers.
/// - **Adaptive GPS cadence** — the position stream's `distanceFilter`/accuracy
///   are reconfigured from the plan (fast/active/idle).
/// - **Foreground service** — a persistent notification keeps Android from
///   killing background location while sharing (the hook legacy never wired).
/// - **Ghost hard-stop** — cancels GPS *and* the foreground service.
///
/// Emits [Fix]es on [fixes]; the relay layer subscribes.
class LocationService {
  LocationService({
    EngineConfig config = const EngineConfig(),
    this.heartbeat = const Duration(minutes: 15),
    Future<LocationPermission> Function()? checkPermission,
    Future<LocationPermission> Function()? requestPermission,
    Stream<Position> Function(LocationSettings)? positionStream,
    Future<Position> Function(LocationSettings)? currentPosition,
    Stream<AccelerometerEvent> Function()? accelStream,
  })  : _machine = LocationStateMachine(config: config),
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

  /// While stationary (idle/sleeping) GPS is OFF for battery, but a cheap
  /// low-accuracy (network/fused) fix on this cadence keeps presence fresh so a
  /// viewer still sees "at home". This is the battery-first heartbeat — GPS
  /// bursts only when actually moving (the win over always-poll trackers).
  final Duration heartbeat;

  final _fixes = StreamController<Fix>.broadcast();
  Stream<Fix> get fixes => _fixes.stream;

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
      if (!await ensurePermission()) return;
      _started = true;
    }
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
      return;
    }

    switch (plan.activity) {
      case LocationActivity.idle:
      case LocationActivity.sleeping:
        // Layer 1: GPS OFF, accelerometer armed to wake on motion, plus a cheap
        // periodic network fix so a stationary person still reports presence.
        _stopGps();
        _startAccel();
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
    _gpsSub = _positionStream(settings).listen(_onPosition,
        onError: (Object e) {
      if (kDebugMode) debugPrint('gps error: $e');
    });
  }

  LocationSettings _androidSettings(EnginePlan plan) {
    final moving = plan.activity == LocationActivity.fast ||
        plan.activity == LocationActivity.active;
    // distanceFilter is the battery lever: only emit after real movement.
    final distanceFilter = switch (plan.activity) {
      LocationActivity.fast => 10,
      LocationActivity.active => 5,
      _ => 50,
    };
    return AndroidSettings(
      accuracy: moving ? LocationAccuracy.high : LocationAccuracy.medium,
      distanceFilter: distanceFilter,
      intervalDuration: plan.gpsInterval,
      // The foreground service is what survives background + doze; only shown
      // while actively sharing (plan.foregroundService).
      foregroundNotificationConfig: plan.foregroundService
          ? const ForegroundNotificationConfig(
              notificationTitle: 'Point',
              notificationText: 'Sharing your location',
              enableWakeLock: true,
              notificationIcon:
                  AndroidResource(name: 'ic_launcher'),
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
            _lastFix!.lat, _lastFix!.lon, fix.lat, fix.lon);
    _lastFix = fix;
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
      final magnitude =
          (e.x * e.x + e.y * e.y + e.z * e.z) - (9.81 * 9.81);
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
      try {
        final p = await _currentPosition(
          const LocationSettings(
            accuracy: LocationAccuracy.low,
            // Fail fast instead of spinning if a fix can't be had (measured:
            // an unbounded request burns CPU when location is unavailable).
            timeLimit: Duration(seconds: 20),
          ),
        );
        // Ghost (or dispose) can land while the request is in flight, and a
        // hard stop only cancels FUTURE ticks — a fix must never leak out
        // past go-dark (safety-critical; v1.2.1 review).
        if (!timer.isActive || !_machine.plan.gpsEnabled) return;
        _emit(p);
      } on Object catch (e) {
        if (kDebugMode) debugPrint('heartbeat fix error: $e');
      }
    });
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
    _fixes.add(fix);
  }

  void _stopGps() {
    _gpsSub?.cancel();
    _gpsSub = null;
    _appliedGpsPlan = null;
  }

  void _stopAccel() {
    _accelSub?.cancel();
    _accelSub = null;
  }

  Future<void> dispose() async {
    await _stopGpsAsync();
    await _accelSub?.cancel();
    _stillnessTimer?.cancel();
    _heartbeatTimer?.cancel();
    await _fixes.close();
  }

  Future<void> _stopGpsAsync() async {
    await _gpsSub?.cancel();
    _gpsSub = null;
  }
}
