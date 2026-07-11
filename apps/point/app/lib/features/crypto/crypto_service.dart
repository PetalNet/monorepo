import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:point_app/src/rust/api/crypto.dart';

/// Client-side MLS over the lifted point-core engine (via flutter_rust_bridge).
///
/// **MLS state durability (GO-bar #2):** the full MLS state is exported after
/// every mutation and persisted to platform secure storage; on boot it is
/// restored, so E2E groups survive an app restart / re-key instead of silently
/// breaking (the legacy defect). All ciphertext is opaque; plaintext never
/// leaves the device except as the caller's own fixes.
class CryptoService {
  CryptoService({FlutterSecureStorage? storage})
      : _storage = storage ?? const FlutterSecureStorage();

  static const _statePrefix = 'point.mls.state.';

  final FlutterSecureStorage _storage;
  PointMls? _mls;
  String? _identity;

  bool get isReady => _mls != null;

  /// Restore this identity's MLS state, or create a fresh one. Idempotent per
  /// identity. Returns true if an existing state was restored.
  Future<bool> init(String identity) async {
    if (_mls != null && _identity == identity) return true;
    _identity = identity;
    final key = '$_statePrefix$identity';
    final stored = await _storage.read(key: key);
    if (stored != null) {
      try {
        _mls = PointMls.restore(state: base64Decode(stored));
        return true;
      } on Object catch (e) {
        // Corrupt/incompatible blob: fall back to a fresh identity and re-join
        // groups via the normal Welcome/Commit flow.
        if (kDebugMode) debugPrint('mls restore failed, starting fresh: $e');
      }
    }
    _mls = PointMls(identity: identity);
    await _persist();
    return false;
  }

  Future<void> _persist() async {
    final mls = _mls;
    final id = _identity;
    if (mls == null || id == null) return;
    final blob = await mls.exportState();
    await _storage.write(
      key: '$_statePrefix$id',
      value: base64Encode(blob),
    );
  }

  PointMls get _require =>
      _mls ?? (throw StateError('CryptoService.init() not called'));

  /// A fresh one-time KeyPackage for the server pool. Generating one mutates
  /// storage, so we persist.
  Future<Uint8List> generateKeyPackage() async {
    final kp = await _require.generateKeyPackage();
    await _persist();
    return kp;
  }

  /// The deterministic MLS group id for a pairwise (direct) share.
  static Uint8List pairwiseGroupId(String a, String b) {
    final (lo, hi) = a.compareTo(b) < 0 ? (a, b) : (b, a);
    return Uint8List.fromList(utf8.encode('dm:$lo:$hi'));
  }

  /// Group id bytes for a server-side group uuid.
  static Uint8List groupIdFor(String serverGroupId) =>
      Uint8List.fromList(utf8.encode(serverGroupId));

  Future<void> createGroup(Uint8List groupId) async {
    await _require.createGroup(groupId: groupId);
    await _persist();
  }

  bool hasGroup(Uint8List groupId) => _require.hasGroup(groupId: groupId);

  /// Add a member from their KeyPackage → (Welcome for them, Commit for us).
  Future<AddMemberResult> addMember(
    Uint8List groupId,
    Uint8List keyPackage,
  ) async {
    final r = await _require.addMember(groupId: groupId, keyPackage: keyPackage);
    await _persist();
    return r;
  }

  Future<Uint8List> processWelcome(Uint8List welcome) async {
    final gid = await _require.processWelcome(welcome: welcome);
    await _persist();
    return gid;
  }

  Future<void> processCommit(Uint8List groupId, Uint8List commit) async {
    await _require.processCommit(groupId: groupId, commit: commit);
    await _persist();
  }

  /// Encrypt a fix. The ratchet advances, so state is persisted (durability).
  Future<Uint8List> encrypt(Uint8List groupId, Uint8List plaintext) async {
    final ct = await _require.encrypt(groupId: groupId, plaintext: plaintext);
    await _persist();
    return ct;
  }

  /// Decrypt a group ciphertext. Also advances the ratchet → persist.
  Future<Uint8List> decrypt(Uint8List groupId, Uint8List ciphertext) async {
    final pt = await _require.decrypt(groupId: groupId, ciphertext: ciphertext);
    await _persist();
    return pt;
  }
}
