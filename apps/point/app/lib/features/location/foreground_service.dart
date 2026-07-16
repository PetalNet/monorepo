import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// Controls OUR OWN persistent Android foreground service — the one Point runs
/// itself, independent of geolocator's.
///
/// Why we run our own (DEFECT #2, the go-dark/battery blocker): geolocator's
/// Android position stream CACHES itself and IGNORES new `LocationSettings`
/// while any listener is active (geolocator_android `getPositionStream`:
/// `if (_positionStream != null) return _positionStream!`). So adaptive cadence
/// never changes after the first fix unless the stream is fully CANCELED (drop
/// to zero listeners → the cache resets) and reopened. But geolocator ties ITS
/// foreground service to that stream, so a cancel tears the FGS down — and on
/// Android 12+ a foreground-service-with-location cannot be (re)started from the
/// background, which is exactly the "leave home and go dark" bug.
///
/// The fix: run our OWN foreground service (a native Android FGS we control),
/// started when sharing begins and kept alive for the whole session. With the
/// process already foreground-promoted by our FGS, geolocator's stream can be
/// freely canceled + reopened to change cadence — its cache resets on cancel so
/// the new settings apply — WITHOUT ever stopping our FGS, so there is no
/// Android-12 background-start block. geolocator is told NOT to run its own FGS
/// (`foregroundNotificationConfig: null`); ours carries the process instead.
///
/// A seam (not a bare `MethodChannel`) so the engine's start/stop lifecycle is
/// unit-testable headless with a fake — the whole point of the 1.2 rework.
abstract interface class ForegroundServiceController {
  /// Start (or no-op if already running) the persistent location foreground
  /// service. Idempotent. Also persists the "active share" flag the native
  /// boot/restart path (R9) reads to resume sharing after a kill/reboot.
  Future<void> start();

  /// Stop the foreground service and clear the active-share flag. Idempotent.
  Future<void> stop();
}

/// The real Android implementation over a platform channel. On non-Android
/// targets (web/desktop tests, the geolocator web impl) every call is a no-op —
/// there is no background service there.
class PlatformForegroundServiceController implements ForegroundServiceController {
  const PlatformForegroundServiceController();

  static const _channel = MethodChannel('dev.petalcat.point/foreground_service');

  bool get _supported =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

  @override
  Future<void> start() async {
    if (!_supported) return;
    try {
      await _channel.invokeMethod<void>('start');
    } on Object catch (e) {
      // A foreground-service start can be refused (missing permission, an OS
      // background-start window) or the channel may be unregistered on a
      // headless engine (R9), which raises MissingPluginException. Never let any
      // of that crash the engine — the fixes still relay; surface it in debug.
      if (kDebugMode) debugPrint('foreground service start failed: $e');
    }
  }

  @override
  Future<void> stop() async {
    if (!_supported) return;
    try {
      await _channel.invokeMethod<void>('stop');
    } on Object catch (e) {
      if (kDebugMode) debugPrint('foreground service stop failed: $e');
    }
  }
}
