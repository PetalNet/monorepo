import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/settings/app_settings.dart';

/// Owns the persisted [AppSettings]. Loads asynchronously on first read (the
/// defaults apply until then, same pattern as the server-url notifier) and
/// writes through on every change.
class SettingsController extends Notifier<AppSettings> {
  SettingsController([FlutterSecureStorage? storage])
    : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;
  static const _key = 'point.settings';

  @override
  AppSettings build() {
    _load();
    return const AppSettings();
  }

  Future<void> _load() async {
    final raw = await _storage.read(key: _key);
    if (raw == null) return;
    try {
      state = AppSettings.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } on Object {
      // A corrupt blob resets to defaults rather than wedging startup.
      await _storage.delete(key: _key);
    }
  }

  Future<void> update(AppSettings Function(AppSettings) change) async {
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
