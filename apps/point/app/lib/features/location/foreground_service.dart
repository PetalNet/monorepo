import 'dart:async';

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
  ///
  /// Returns whether the platform ACCEPTED the start (Defect #4). An Android 12+
  /// foreground-service-with-location start can be REFUSED from the background
  /// (`ForegroundServiceStartNotAllowedException`, thrown synchronously by
  /// `startForegroundService`); `false` tells the engine not to latch the FGS as
  /// running and to re-arm. Platforms with no FGS (web/desktop) return `true` —
  /// nothing to keep alive there, so no retry.
  Future<bool> start();

  /// Stop the foreground service and clear the active-share flag. Idempotent.
  Future<void> stop();

  /// Defect #1-remnant: the survival-critical PROMOTION result, delivered
  /// asynchronously AFTER [start] returns. [start]'s bool only reports whether
  /// the OS ACCEPTED the start REQUEST (`startForegroundService` did not throw);
  /// the process is only truly foreground-promoted once the service's async
  /// `startForeground` runs (in `onStartCommand`). That promotion can STILL be
  /// refused on Android 12+ (a background FGS-with-location start) — the service
  /// then stops itself, so the FGS is DOWN while [start] already reported
  /// "accepted". This stream emits `false` on such a refusal (the engine must
  /// un-latch the FGS and re-arm) and `true` on a confirmed promotion. Platforms
  /// with no FGS (web/desktop) never emit — there is nothing to promote.
  Stream<bool> get promotions;
}

/// The real Android implementation over a platform channel. On non-Android
/// targets (web/desktop tests, the geolocator web impl) every call is a no-op —
/// there is no background service there.
class PlatformForegroundServiceController implements ForegroundServiceController {
  PlatformForegroundServiceController();

  static const _channel = MethodChannel('dev.petalcat.point/foreground_service');

  final _promotions = StreamController<bool>.broadcast();
  bool _handlerBound = false;

  bool get _supported =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

  @override
  Stream<bool> get promotions => _promotions.stream;

  /// Defect #1-remnant: bind the native→Dart promotion handler once, lazily on
  /// the first [start]. Deferred out of the constructor so merely BUILDING the
  /// controller needs no Flutter binding — a unit test that constructs
  /// `LocationService()` only to read a constant must not require
  /// `ensureInitialized()`, and `setMethodCallHandler` asserts without a binary
  /// messenger. By the time [start] runs the app has a binding, and the native
  /// side only reports a promotion AFTER a start request, so the handler is
  /// always bound before any `onForegroundPromotion` can arrive.
  void _bindPromotionHandler() {
    if (_handlerBound) return;
    _handlerBound = true;
    _channel.setMethodCallHandler(_handlePlatformCall);
  }

  Future<Object?> _handlePlatformCall(MethodCall call) async {
    // Native → Dart: the service reports whether the async `startForeground`
    // PROMOTION succeeded (Defect #1-remnant). `start`'s return value only
    // covered the synchronous accept of `startForegroundService`.
    if (call.method == 'onForegroundPromotion') {
      final promoted = call.arguments as bool? ?? false;
      if (!_promotions.isClosed) _promotions.add(promoted);
    }
    return null;
  }

  @override
  Future<bool> start() async {
    // No FGS off Android — nothing to keep alive, so report success (no retry).
    if (!_supported) return true;
    _bindPromotionHandler();
    try {
      // The native side returns whether `startForegroundService` was accepted
      // (Defect #4). A refused Android-12 background start comes back `false`
      // (or throws) so the engine re-arms instead of latching a dead FGS.
      final ok = await _channel.invokeMethod<bool>('start');
      return ok ?? false;
    } on Object catch (e) {
      // A foreground-service start can be refused (missing permission, an OS
      // background-start window) or the channel may be unregistered on a
      // headless engine (R9), which raises MissingPluginException. Never let any
      // of that crash the engine — the fixes still relay; surface it in debug
      // and report failure so the engine re-arms.
      if (kDebugMode) debugPrint('foreground service start failed: $e');
      return false;
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
