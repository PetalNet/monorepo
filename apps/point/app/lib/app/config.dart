import 'package:flutter/foundation.dart';

/// Runtime configuration for which home-server the client talks to.
///
/// A RELEASE build (a sideloaded/store APK on a real phone) defaults to the
/// public home-server `https://point.petalcat.dev`. Debug builds default to the
/// dev address (Android emulator loopback `10.0.2.2`, or localhost on web).
/// Either can be overridden at build time via `--dart-define=POINT_SERVER=...`.
///
/// `serverBaseUrl` is the bare origin — no trailing slash, no `/api`. The API
/// client appends the path itself (e.g. `$baseUrl/api/register`).
abstract final class AppConfig {
  static const _defineServer =
      String.fromEnvironment('POINT_SERVER');

  static String get serverBaseUrl {
    if (_defineServer.isNotEmpty) return _defineServer;
    if (kReleaseMode) return 'https://point.petalcat.dev';
    if (kIsWeb) return 'http://localhost:8330';
    // TargetPlatform is not available without a binding here; the emulator
    // loopback is the safe dev default for Android-first.
    return 'http://10.0.2.2:8330';
  }
}
