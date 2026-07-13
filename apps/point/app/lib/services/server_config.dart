import 'dart:async';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/app/config.dart';

/// The Point home-server the client talks to, chosen at runtime on the login /
/// register screen so anyone can point the app at their own self-hosted Point
/// server. Defaults to [AppConfig.serverBaseUrl] (https://point.petalcat.dev in
/// release) and is persisted so the choice survives restarts.
///
/// The value is a BARE origin — scheme + host [+ port], no trailing slash and no
/// `/api`. The API client and WS relay append their own paths.
class ServerUrlNotifier extends Notifier<String> {
  ServerUrlNotifier([FlutterSecureStorage? storage])
    : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;
  static const _key = 'point.server_url';

  @override
  String build() {
    // Async-load any persisted choice; until then, the default applies.
    unawaited(_load());
    return AppConfig.serverBaseUrl;
  }

  Future<void> _load() async {
    final saved = await _storage.read(key: _key);
    if (saved != null && saved.isNotEmpty) state = saved;
  }

  /// Whether a server has ever been explicitly chosen on this device. A fresh
  /// install starts the signed-out flow at the server-pick step; a device
  /// with a choice starts at sign-in (server pick one step back).
  Future<bool> hasSavedChoice() async {
    final saved = await _storage.read(key: _key);
    return saved != null && saved.isNotEmpty;
  }

  /// Normalize, apply, and persist a server origin. An empty value resets to the
  /// default.
  Future<void> set(String raw) async {
    final url = normalize(raw);
    state = url;
    await _storage.write(key: _key, value: url);
  }

  /// Coerce user input into a bare origin: add https:// if no scheme, drop any
  /// trailing slash, and strip a trailing `/api` (the client appends it itself).
  static String normalize(String raw) {
    var s = raw.trim();
    if (s.isEmpty) return AppConfig.serverBaseUrl;
    if (!s.startsWith('http://') && !s.startsWith('https://')) {
      s = 'https://$s';
    }
    s = s.replaceAll(RegExp(r'/+$'), '');
    if (s.toLowerCase().endsWith('/api')) {
      s = s.substring(0, s.length - '/api'.length);
    }
    return s;
  }
}

final serverUrlProvider = NotifierProvider<ServerUrlNotifier, String>(
  ServerUrlNotifier.new,
);
