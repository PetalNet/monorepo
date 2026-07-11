import 'package:flutter/foundation.dart';

/// Runtime configuration for which home-server the client talks to. In dev the
/// Android emulator reaches the host at `10.0.2.2`; web/desktop use localhost.
/// Overridable at build time via `--dart-define=POINT_SERVER=...`.
abstract final class AppConfig {
  static const _defineServer =
      String.fromEnvironment('POINT_SERVER');

  static String get serverBaseUrl {
    if (_defineServer.isNotEmpty) return _defineServer;
    if (kIsWeb) return 'http://localhost:8330';
    // TargetPlatform is not available without a binding here; the emulator
    // loopback is the safe dev default for Android-first.
    return 'http://10.0.2.2:8330';
  }
}
