import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:point_app/services/api/models.dart';

/// Persists the signed-in [Session] in platform secure storage (Android
/// Keystore-backed). Only the server session lives here; E2E key material is
/// device-linked + recovery-secret backed (M2/M4), separate from login.
class SessionStore {
  SessionStore([FlutterSecureStorage? storage])
      : _storage = storage ?? const FlutterSecureStorage();

  static const _key = 'point.session';
  final FlutterSecureStorage _storage;

  Future<Session?> read() async {
    final raw = await _storage.read(key: _key);
    if (raw == null) return null;
    try {
      return Session.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } on Object {
      await clear();
      return null;
    }
  }

  Future<void> write(Session session) => _storage.write(
        key: _key,
        value: jsonEncode({
          'token': session.token,
          'user_id': session.userId,
          'display_name': session.displayName,
          'is_admin': session.isAdmin,
        }),
      );

  Future<void> clear() => _storage.delete(key: _key);
}
