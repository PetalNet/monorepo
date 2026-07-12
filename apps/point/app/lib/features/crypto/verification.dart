import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

/// Who I've verified out-of-band (compared safety numbers). Persisted locally —
/// verification is a personal trust decision, and TOFU already covers the happy
/// path, so this is the optional extra assurance layer.
class VerificationController extends Notifier<Set<String>> {
  VerificationController([FlutterSecureStorage? storage])
      : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;
  static const _key = 'point.verified';

  @override
  Set<String> build() {
    _load();
    return const {};
  }

  Future<void> _load() async {
    final raw = await _storage.read(key: _key);
    if (raw != null) {
      state = (jsonDecode(raw) as List<dynamic>).cast<String>().toSet();
    }
  }

  bool isVerified(String userId) => state.contains(userId);

  Future<void> markVerified(String userId) async {
    state = {...state, userId};
    await _storage.write(key: _key, value: jsonEncode(state.toList()));
  }

  Future<void> clear(String userId) async {
    state = {...state}..remove(userId);
    await _storage.write(key: _key, value: jsonEncode(state.toList()));
  }
}

final verificationProvider =
    NotifierProvider<VerificationController, Set<String>>(
  VerificationController.new,
);
