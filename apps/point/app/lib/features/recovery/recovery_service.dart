import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/relay/relay_controller.dart'
    show cryptoServiceProvider;
import 'package:point_app/services/auth_controller.dart' show apiProvider;
import 'package:point_app/src/rust/api/recovery.dart' as rust;

/// Zero-knowledge account recovery.
///
/// The device encrypts its exported MLS state under a key derived from a
/// user-held **recovery code** and uploads the opaque blob to the home-server.
/// The server stores ciphertext it cannot decrypt (see `point_core::recovery`
/// and `server/src/api/recovery.rs`). On a new device the user re-enters the
/// code to decrypt the fetched blob and restore their identity + groups.
///
/// The recovery code is cached in platform secure storage AFTER enrollment so
/// backups can refresh as MLS state advances. That adds no exposure the device
/// doesn't already have: the plaintext MLS state itself lives in the same secure
/// storage, so a device compromise already loses everything the code protects.
/// The point of "zero-knowledge" here is that the SERVER never learns the code —
/// and it never does.
class RecoveryService {
  RecoveryService(this._ref, {FlutterSecureStorage? storage})
    : _storage = storage ?? const FlutterSecureStorage();

  final Ref _ref;
  final FlutterSecureStorage _storage;

  static const _codeKey = 'point.recovery.code';

  /// Whether a recovery code has been enrolled on THIS device.
  Future<bool> isEnrolled() async =>
      (await _storage.read(key: _codeKey)) != null;

  /// The locally-cached recovery code, if this device has enrolled (used to
  /// re-show the phrase; it never leaves the device).
  Future<String?> cachedCode() => _storage.read(key: _codeKey);

  /// Generate a fresh recovery code, cache it locally, and upload a first
  /// encrypted backup. Returns the code to show the user exactly once — it is
  /// the only thing that can recover the account, and it is never sent anywhere.
  Future<String> enroll(String token) async {
    final code = rust.generateRecoveryCode();
    await _storage.write(key: _codeKey, value: code);
    await _backupWithCode(token, code);
    return code;
  }

  /// Re-encrypt and upload the current MLS state under the already-enrolled
  /// code. No-op (returns false) if this device has never enrolled. Call after
  /// state-changing events so the backup doesn't drift behind the live epoch.
  Future<bool> refreshBackup(String token) async {
    final code = await _storage.read(key: _codeKey);
    if (code == null) return false;
    try {
      await _backupWithCode(token, code);
      return true;
    } on Object catch (e) {
      if (kDebugMode) debugPrint('recovery backup refresh failed: $e');
      return false;
    }
  }

  Future<void> _backupWithCode(String token, String code) async {
    final crypto = _ref.read(cryptoServiceProvider);
    final api = _ref.read(apiProvider);
    final state = await crypto.exportRawState();
    final blob = rust.recoveryEncrypt(state: state, recoveryCode: code);
    await api.putRecoveryBackup(token, base64Encode(blob));
  }

  /// Restore this account's MLS identity on a NEW device: fetch the encrypted
  /// backup, decrypt it with the user-supplied [code], and install the state.
  /// Caches the code so subsequent backups keep refreshing. Returns false if no
  /// backup exists on the server; throws [RecoveryFailure] on a wrong code or a
  /// corrupt blob (fail-closed).
  Future<bool> restore({
    required String token,
    required String identity,
    required String code,
  }) async {
    final api = _ref.read(apiProvider);
    final backup = await api.getRecoveryBackup(token);
    if (backup == null) return false;

    final Uint8List state;
    try {
      state = rust.recoveryDecrypt(
        blob: base64Decode(backup.blobBase64),
        recoveryCode: code,
      );
    } on Object catch (_) {
      throw const RecoveryFailure(
        'That recovery code did not match this backup.',
      );
    }

    await _ref.read(cryptoServiceProvider).restoreFromState(identity, state);
    await _storage.write(key: _codeKey, value: code);
    return true;
  }

  /// Forget the locally-cached recovery code (backups stop refreshing until
  /// re-enrolled). Does not touch the server-side backup.
  Future<void> forgetLocalCode() => _storage.delete(key: _codeKey);
}

/// A recovery attempt failed in a way the user can act on (wrong code / corrupt
/// backup). Distinct from network/API errors, which propagate as-is.
class RecoveryFailure implements Exception {
  const RecoveryFailure(this.message);
  final String message;
  @override
  String toString() => message;
}

final recoveryServiceProvider = Provider<RecoveryService>(
  RecoveryService.new,
);
