import 'dart:async';
import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/settings/app_settings.dart';

/// Owns the persisted [AppSettings]. Loads asynchronously on first read (the
/// defaults apply until then) and writes through on every change.
///
/// Anything that makes a DECISION off these settings (the launch gate) must
/// await [loaded] first: reading the provider synchronously on a cold start
/// races the storage load and sees the defaults, which is exactly how a
/// finished account would get re-gated into the privacy fork.
class SettingsController extends Notifier<AppSettings> {
  SettingsController([FlutterSecureStorage? storage])
    : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;
  static const _key = 'point.settings';

  final Completer<void> _loaded = Completer<void>();
  bool _touched = false;

  /// Resolves once the persisted settings are in [state] (or confirmed
  /// absent). After this, synchronous reads are trustworthy.
  Future<AppSettings> get loaded async {
    await _loaded.future;
    return state;
  }

  @override
  AppSettings build() {
    unawaited(_load());
    return const AppSettings();
  }

  Future<void> _load() async {
    try {
      final raw = await _storage.read(key: _key);
      // An explicit change that landed while the read was in flight wins over
      // the stale persisted blob.
      if (raw != null && !_touched) {
        state = AppSettings.fromJson(jsonDecode(raw) as Map<String, dynamic>);
      }
    } on Object {
      // A corrupt blob resets to defaults rather than wedging startup.
      await _storage.delete(key: _key);
    } finally {
      if (!_loaded.isCompleted) _loaded.complete();
    }
  }

  Future<void> update(AppSettings Function(AppSettings) change) async {
    _touched = true;
    state = change(state);
    await _storage.write(key: _key, value: jsonEncode(state.toJson()));
  }

  /// Apply the onboarding privacy fork: one plain-language choice sets the
  /// map tier and the notification transport together (fine-tunable later in
  /// Settings). Private keeps everything on the user's own servers; the
  /// convenient path uses the server-proxied map and FCM.
  ///
  /// The convenient path is complete in itself, so it marks the transport
  /// chosen. The private path stays un-chosen until the distributor
  /// walk-through finishes (see [markTransportChosen]), so killing the app
  /// mid-guide resumes at the fork.
  Future<void> applyPrivacyFork({required bool private}) => update(
    (s) => s.copyWith(
      mapProvider: private
          ? MapProviderChoice.selfHosted
          : MapProviderChoice.proxied,
      transport: private ? NotifTransport.unifiedPush : NotifTransport.fcm,
      fcmFallback: !private,
      transportChosen: !private,
    ),
  );

  /// Record that the transport choice is deliberate and complete (the
  /// distributor guide finished, or a Settings change was made).
  Future<void> markTransportChosen() =>
      update((s) => s.copyWith(transportChosen: true));
}

final settingsProvider = NotifierProvider<SettingsController, AppSettings>(
  SettingsController.new,
);
