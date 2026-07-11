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
  }) : _machine = LocationStateMachine(config: config);

  final LocationStateMachine _machine;

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
  Fix? _lastFix;

  static const _motionThreshold = 1.2; // m/s^2 over gravity baseline
  static const _stillnessBackground = Duration(seconds: 30);

  LocationActivity get activity => _machine.activity;
  EnginePlan get plan => _machine.plan;

  Future<bool> ensurePermission() async {
    var perm = await Geolocator.checkPermission();
    if (perm == LocationPermission.denied) {
      perm = await Geolocator.requestPermission();
    }
    return perm == LocationPermission.always ||
        perm == LocationPermission.whileInUse;
  }

  /// Start the engine (call once sharing begins).
  Future<void> start() async {
    if (!await ensurePermission()) return;
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
    }
    _appliedActivity = plan.activity;
  }

  void _startGps(EnginePlan plan) {
    // Reconfigure only when the activity (and thus cadence) actually changed —
    // reopening the stream on every fix would defeat the battery savings.
    if (_gpsSub != null && _appliedActivity == plan.activity) return;
    _stopGps();
    final settings = _androidSettings(plan);
    _gpsSub = Geolocator.getPositionStream(locationSettings: settings)
        .listen(_onPosition, onError: (Object e) {
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
    _accelSub = accelerometerEventStream().listen((e) {
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
    _heartbeatTimer = Timer.periodic(heartbeat, (_) async {
      // Cheap fix while parked: low accuracy uses network/fused, not the GPS
      // radio, so it costs a fraction of a real GPS lock.
      try {
        final p = await Geolocator.getCurrentPosition(
          locationSettings: const LocationSettings(
            accuracy: LocationAccuracy.low,
          ),
        );
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
