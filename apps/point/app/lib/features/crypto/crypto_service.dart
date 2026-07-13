import 'dart:async';
import 'dart:collection';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:point_app/src/rust/api/crypto.dart';

/// Outcome of [CryptoService.init].
enum MlsInit {
  /// An existing MLS state was restored — groups intact.
  restored,

  /// A brand-new identity (first run) was created.
  created,

  /// A stored state existed but could NOT be restored (corrupt/incompatible);
  /// a fresh identity replaced it. The caller MUST re-provision: upload a fresh
  /// KeyPackage pool (the old private halves are gone) and re-form its groups,
  /// else peers silently fail to reach it. Surfaced, never swallowed (H1).
  wiped,
}

enum MailboxApplyResult { applied, alreadyApplied }

/// Client-side MLS over the lifted point-core engine (via flutter_rust_bridge).
///
/// **MLS state durability (GO-bar #2):** the full MLS state is exported after
/// every mutation and persisted to platform secure storage; on boot it is
/// restored, so E2E groups survive an app restart / re-key.
///
/// Every mutating method runs under a single async lock so that
/// `mutate → export → write` is atomic and strictly ordered — concurrent
/// encrypts can never persist a rewound ratchet (which would risk AEAD
/// generation reuse on the next restore). All ciphertext is opaque; plaintext
/// never leaves the device except as the caller's own fixes.
class CryptoService {
  CryptoService({FlutterSecureStorage? storage})
    : _storage = storage ?? const FlutterSecureStorage();

  static const _statePrefix = 'point.mls.state.';

  final FlutterSecureStorage _storage;
  PointMls? _mls;
  String? _identity;
  final LinkedHashSet<String> _appliedMailboxIds = LinkedHashSet<String>();

  static const _stateEnvelopePrefix = 'v1:';

  // Async mutex: chains mutating operations so mutate+persist is one unit.
  Future<void> _lockTail = Future<void>.value();

  bool get isReady => _mls != null;

  Future<T> _locked<T>(Future<T> Function() action) {
    final completer = Completer<void>();
    final prev = _lockTail;
    _lockTail = completer.future;
    return prev.then((_) => action()).whenComplete(completer.complete);
  }

  /// Restore this identity's MLS state, or create a fresh one. Idempotent per
  /// identity.
  Future<MlsInit> init(String identity) async {
    if (_mls != null && _identity == identity) return MlsInit.restored;
    return _locked(() async {
      _identity = identity;
      _appliedMailboxIds.clear();
      final key = '$_statePrefix$identity';
      final stored = await _storage.read(key: key);
      if (stored != null) {
        try {
          final Uint8List state;
          if (stored.startsWith(_stateEnvelopePrefix)) {
            final envelope =
                jsonDecode(
                      stored.substring(_stateEnvelopePrefix.length),
                    )
                    as Map<String, dynamic>;
            state = base64Decode(envelope['state'] as String);
            _appliedMailboxIds.addAll(
              (envelope['applied_mailbox_ids'] as List<dynamic>? ?? const [])
                  .cast<String>(),
            );
          } else {
            // Backward-compatible migration from the original raw-base64
            // secure-storage value. The next mutation writes an envelope.
            state = base64Decode(stored);
          }
          _mls = PointMls.restore(state: state);
          return MlsInit.restored;
        } on Object catch (e) {
          if (kDebugMode) debugPrint('mls restore failed, re-keying: $e');
          _mls = PointMls(identity: identity);
          await _persistUnlocked();
          return MlsInit.wiped;
        }
      }
      _mls = PointMls(identity: identity);
      await _persistUnlocked();
      return MlsInit.created;
    });
  }

  Future<void> _persistUnlocked() async {
    final mls = _mls;
    final id = _identity;
    if (mls == null || id == null) return;
    final blob = await mls.exportState();
    await _storage.write(
      key: '$_statePrefix$id',
      value:
          '$_stateEnvelopePrefix${jsonEncode({
            'state': base64Encode(blob),
            'applied_mailbox_ids': _appliedMailboxIds.toList(),
          })}',
    );
  }

  PointMls get _require =>
      _mls ?? (throw StateError('CryptoService.init() not called'));

  Future<Uint8List> generateKeyPackage() => _locked(() async {
    final kp = await _require.generateKeyPackage();
    await _persistUnlocked();
    return kp;
  });

  /// The deterministic MLS group id for a pairwise (direct) share.
  static Uint8List pairwiseGroupId(String a, String b) {
    final (lo, hi) = a.compareTo(b) < 0 ? (a, b) : (b, a);
    return Uint8List.fromList(utf8.encode('dm:$lo:$hi'));
  }

  /// Group id bytes for a server-side group uuid.
  static Uint8List groupIdFor(String serverGroupId) =>
      Uint8List.fromList(utf8.encode(serverGroupId));

  Future<void> createGroup(Uint8List groupId) => _locked(() async {
    await _require.createGroup(groupId: groupId);
    await _persistUnlocked();
  });

  bool hasGroup(Uint8List groupId) => _require.hasGroup(groupId: groupId);

  Future<AddMemberResult> addMember(Uint8List groupId, Uint8List keyPackage) =>
      _locked(() async {
        final r = await _require.addMember(
          groupId: groupId,
          keyPackage: keyPackage,
        );
        await _persistUnlocked();
        return r;
      });

  Future<Uint8List> processWelcome(Uint8List welcome) => _locked(() async {
    final gid = await _require.processWelcome(welcome: welcome);
    await _persistUnlocked();
    return gid;
  });

  Future<void> processCommit(Uint8List groupId, Uint8List commit) =>
      _locked(() async {
        await _require.processCommit(groupId: groupId, commit: commit);
        await _persistUnlocked();
      });

  /// Apply a mailbox Welcome exactly once. The MLS state and applied-id marker
  /// share one secure-storage envelope; if that write fails, the in-memory MLS
  /// engine rolls back to its pre-message snapshot and the server row remains
  /// unacknowledged for a safe retry.
  Future<MailboxApplyResult> processMailboxWelcome(
    String messageId,
    Uint8List welcome,
  ) => _processMailboxMessage(messageId, () async {
    await _require.processWelcome(welcome: welcome);
  });

  /// Apply a mailbox Commit with the same durable exactly-once boundary used
  /// for Welcomes.
  Future<MailboxApplyResult> processMailboxCommit(
    String messageId,
    Uint8List groupId,
    Uint8List commit,
  ) => _processMailboxMessage(messageId, () async {
    await _require.processCommit(groupId: groupId, commit: commit);
  });

  Future<MailboxApplyResult> _processMailboxMessage(
    String messageId,
    Future<void> Function() mutate,
  ) => _locked(() async {
    if (_appliedMailboxIds.contains(messageId)) {
      return MailboxApplyResult.alreadyApplied;
    }
    final before = await _require.exportState();
    try {
      await mutate();
      _appliedMailboxIds.add(messageId);
      await _persistUnlocked();
      return MailboxApplyResult.applied;
    } on Object {
      _mls = PointMls.restore(state: before);
      _appliedMailboxIds.remove(messageId);
      rethrow;
    }
  });

  /// Forget the local replay guard only after the server has durably ACKed the
  /// row. Until then it must remain unbounded by age: evicting an unacked id
  /// would permit a later drain to apply the same MLS mutation twice.
  Future<void> markMailboxAcknowledged(String messageId) => _locked(() async {
    if (!_appliedMailboxIds.remove(messageId)) return;
    await _persistUnlocked();
  });

  /// Encrypt a fix. The ratchet advances, so state is persisted atomically.
  Future<Uint8List> encrypt(Uint8List groupId, Uint8List plaintext) => _locked(
    () async {
      final ct = await _require.encrypt(groupId: groupId, plaintext: plaintext);
      await _persistUnlocked();
      return ct;
    },
  );

  /// Decrypt a group ciphertext. Also advances the ratchet → persist atomically.
  Future<Uint8List> decrypt(Uint8List groupId, Uint8List ciphertext) =>
      _locked(() async {
        final pt = await _require.decrypt(
          groupId: groupId,
          ciphertext: ciphertext,
        );
        await _persistUnlocked();
        return pt;
      });

  /// A Signal-style safety number for the pairwise group with a peer — both
  /// sides compute the same value from their identity keys, for optional
  /// out-of-band verification. Throws if the group isn't formed yet.
  Future<String> safetyNumber(Uint8List groupId) =>
      _locked(() async => _require.safetyNumber(groupId: groupId));

  /// The current MLS state as an opaque blob — the input to a zero-knowledge
  /// recovery backup (it is encrypted under the user's recovery code BEFORE it
  /// ever leaves the device). Snapshotted under the lock for a consistent read.
  Future<Uint8List> exportRawState() =>
      _locked(() async => _require.exportState());

  /// Replace this identity's MLS state from a recovery blob (already decrypted
  /// on a new device) and persist it as the durable state. After this the
  /// restored identity can decrypt the groups it was a member of.
  Future<void> restoreFromState(String identity, Uint8List state) =>
      _locked(() async {
        _identity = identity;
        _mls = PointMls.restore(state: state);
        _appliedMailboxIds.clear();
        await _persistUnlocked();
      });
}
