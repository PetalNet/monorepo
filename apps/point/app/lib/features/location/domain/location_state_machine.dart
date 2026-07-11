/// The battery-engine GPS state machine (lifted from the legacy design, D-002 /
/// GO-bar #5 — decomposed into a pure, testable unit). It owns the
/// `sleeping → idle → active ↔ fast → sleeping`, `any → ghost` transitions and
/// the GPS cadence for each, with foreground/background awareness. Pure logic:
/// no plugins, no I/O — so it runs under `flutter test` headless (the runtime
/// device path is verified separately; see BLOCKERS.md).
library;

import 'package:flutter/foundation.dart';

enum LocationActivity { sleeping, idle, active, fast, ghost }

/// GPS sampling cadence + whether the foreground service should run, derived
/// from the current activity and app foreground/background state.
@immutable
class EnginePlan {
  const EnginePlan({
    required this.activity,
    required this.gpsInterval,
    required this.foregroundService,
    required this.gpsEnabled,
  });

  final LocationActivity activity;
  final Duration gpsInterval;

  /// The Android foreground service (with its persistent notification) runs
  /// only while actively sharing and not ghosted.
  final bool foregroundService;

  /// Ghost hard-stops the GPS hardware (the legacy `enterGhost` that was never
  /// wired — GO-bar #1/#6). `false` means: do not sample location at all.
  final bool gpsEnabled;

  @override
  bool operator ==(Object other) =>
      other is EnginePlan &&
      other.activity == activity &&
      other.gpsInterval == gpsInterval &&
      other.foregroundService == foregroundService &&
      other.gpsEnabled == gpsEnabled;

  @override
  int get hashCode =>
      Object.hash(activity, gpsInterval, foregroundService, gpsEnabled);
}

/// Tunables (legacy-derived). Kept in one place so the cadence is legible.
class EngineConfig {
  const EngineConfig();

  Duration get activeForeground => const Duration(seconds: 2);
  Duration get activeBackground => const Duration(seconds: 12);
  Duration get fastInterval => const Duration(seconds: 2);
  Duration get idleInterval => const Duration(seconds: 30);
  Duration get sleepingForeground => const Duration(seconds: 60);
  Duration get sleepingBackground => const Duration(seconds: 60);

  /// Speed (m/s) sustained to promote active → fast, and the count of fixes.
  double get fastSpeed => 5;
  int get fastFixes => 3;

  /// Speed (m/s) under which to demote fast → active, and the count.
  double get slowSpeed => 2;
  int get slowFixes => 5;

  /// Movement (metres) from the last relayed fix that wakes idle/sleeping.
  double get wakeDistance => 5;
}

class LocationStateMachine {
  LocationStateMachine({
    this.config = const EngineConfig(),
    bool sharing = true,
    bool foreground = true,
  })  : _sharing = sharing,
        _foreground = foreground,
        _activity =
            sharing ? LocationActivity.idle : LocationActivity.ghost;

  final EngineConfig config;
  LocationActivity _activity;
  bool _sharing;
  bool _foreground;
  int _fastStreak = 0;
  int _slowStreak = 0;

  LocationActivity get activity => _activity;
  bool get sharing => _sharing;
  bool get foreground => _foreground;

  /// Ghost OFF/ON. Ghost forces the engine down (kills GPS + foreground
  /// service); leaving ghost returns to idle so the next fix re-evaluates.
  void setSharing({required bool sharing}) {
    _sharing = sharing;
    if (!sharing) {
      _activity = LocationActivity.ghost;
      _fastStreak = 0;
      _slowStreak = 0;
    } else if (_activity == LocationActivity.ghost) {
      _activity = LocationActivity.idle;
    }
  }

  /// App resumed → jump to active for a snappy fresh fix (foreground open).
  void onForeground() {
    _foreground = true;
    if (_sharing && _activity != LocationActivity.ghost) {
      _activity = LocationActivity.active;
    }
  }

  /// App backgrounded → the engine keeps running (the whole point of GO-bar #1)
  /// but at the calmer background cadence; the plan reflects it.
  void onBackground() => _foreground = false;

  /// Accelerometer / significant-motion wake (foreground gate) from sleeping.
  void onMovementWake() {
    if (!_sharing || _activity == LocationActivity.ghost) return;
    if (_activity == LocationActivity.sleeping ||
        _activity == LocationActivity.idle) {
      _activity = LocationActivity.active;
    }
  }

  /// Stillness elapsed → ramp down toward sleeping.
  void onStillness() {
    if (!_sharing || _activity == LocationActivity.ghost) return;
    _activity = switch (_activity) {
      LocationActivity.fast || LocationActivity.active => LocationActivity.idle,
      LocationActivity.idle => LocationActivity.sleeping,
      _ => _activity,
    };
    _fastStreak = 0;
    _slowStreak = 0;
  }

  /// A GPS fix at [speed] m/s that moved [movedMetres] since the last relayed
  /// fix. Drives active↔fast promotion/demotion and wakes from rest.
  void onGpsFix({required double speed, required double movedMetres}) {
    if (!_sharing || _activity == LocationActivity.ghost) return;

    if ((_activity == LocationActivity.sleeping ||
            _activity == LocationActivity.idle) &&
        movedMetres >= config.wakeDistance) {
      _activity = LocationActivity.active;
    }

    if (speed >= config.fastSpeed) {
      _fastStreak++;
      _slowStreak = 0;
      if (_fastStreak >= config.fastFixes) _activity = LocationActivity.fast;
    } else if (speed <= config.slowSpeed) {
      _slowStreak++;
      _fastStreak = 0;
      if (_activity == LocationActivity.fast &&
          _slowStreak >= config.slowFixes) {
        _activity = LocationActivity.active;
      }
    } else {
      _fastStreak = 0;
      _slowStreak = 0;
    }
  }

  /// The current engine plan (cadence + service flags). The service applies it.
  EnginePlan get plan {
    if (_activity == LocationActivity.ghost || !_sharing) {
      return const EnginePlan(
        activity: LocationActivity.ghost,
        gpsInterval: Duration(minutes: 5),
        foregroundService: false,
        gpsEnabled: false,
      );
    }
    final interval = switch (_activity) {
      LocationActivity.fast => config.fastInterval,
      LocationActivity.active =>
        _foreground ? config.activeForeground : config.activeBackground,
      LocationActivity.idle => config.idleInterval,
      LocationActivity.sleeping =>
        _foreground ? config.sleepingForeground : config.sleepingBackground,
      LocationActivity.ghost => const Duration(minutes: 5),
    };
    return EnginePlan(
      activity: _activity,
      gpsInterval: interval,
      // Foreground service runs whenever sharing & sampling — this is what
      // keeps Android from killing background location (GO-bar #1).
      foregroundService: true,
      gpsEnabled: true,
    );
  }
}
