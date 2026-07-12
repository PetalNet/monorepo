import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/crypto/crypto_service.dart';
import 'package:point_app/features/location/data/location_service.dart';
import 'package:point_app/features/location/location_providers.dart';
import 'package:point_app/features/relay/relay_queue.dart';
import 'package:point_app/features/relay/ws_service.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/services/server_config.dart';

final cryptoServiceProvider = Provider<CryptoService>((_) => CryptoService());

/// A decrypted location fix from a peer (surfaced to the map/People layer).
class PeerFix {
  const PeerFix({required this.userId, required this.data});
  final String userId;
  final Map<String, dynamic> data;
}

/// Assembles the verified M2 pieces into the shipping relay path:
/// - on sign-in: init MLS (durable), top up the one-time KeyPackage POOL,
///   connect the durable WS, and process any pending Welcomes;
/// - outbound: each LocationService fix is MLS-encrypted per accepted share and
///   sent through the durable queue;
/// - inbound: `mls.message` Welcomes join groups; `location.broadcast` frames
///   are decrypted and surfaced as [PeerFix]es.
class RelayController {
  RelayController(this._ref);

  final Ref _ref;
  WsService? _ws;
  StreamSubscription<Fix>? _fixSub;
  StreamSubscription<Map<String, dynamic>>? _wsSub;
  Session? _session;

  /// Server ids of peers we currently share with (their pairwise groups).
  final Set<String> _shareTargets = {};

  /// Targets whose group formation is in flight — prevents a re-entrant
  /// `setShareTargets` from double-claiming KeyPackages / overwriting the group
  /// (M2). Cleared when formation finishes.
  final Set<String> _forming = {};
  final _peerFixes = StreamController<PeerFix>.broadcast();

  /// Decrypted peer fixes for the presence/map layer.
  Stream<PeerFix> get peerFixes => _peerFixes.stream;

  static const _poolFloor = 5;

  Future<void> start(Session session) async {
    _session = session;
    final api = _ref.read(apiProvider);
    final crypto = _ref.read(cryptoServiceProvider);
    final initResult = await crypto.init(session.userId);

    // Top up the one-time KeyPackage pool (multi-KP; GO-bar #4). On a re-key
    // (wiped state) the server still lists our OLD packages whose private
    // halves are gone, so we must force a fresh pool regardless of the count —
    // otherwise peers claim stale packages and silently can't reach us (H1).
    try {
      final forceReprovision = initResult == MlsInit.wiped;
      final count = await api.keyCount(session.token);
      if (forceReprovision || count.available < _poolFloor) {
        final pool = [
          for (var i = 0; i < _poolFloor; i++)
            base64Encode(await crypto.generateKeyPackage()),
        ];
        await api.uploadKeyPackages(session.token, pool);
      }
    } on Object catch (e) {
      if (kDebugMode) debugPrint('keypackage top-up failed: $e');
    }

    // Durable WS (survives disconnect; jittered reconnect).
    final ws = WsService(
      wsUrl: _wsUrlFor(_ref.read(serverUrlProvider)),
      queue: RelayQueue(store: _SecureRelayStore(session.userId)),
    );
    _ws = ws;
    _wsSub = ws.incoming.listen(_onIncoming);
    await ws.start(session.token);

    await _drainPendingWelcomes();

    // Relay each local fix, encrypted per share.
    _fixSub = _ref.read(locationServiceProvider).fixes.listen(_onLocalFix);
  }

  /// Track who we share with; for any new target we don't yet have a group
  /// with, form one (claim their KeyPackage → create the pairwise group → add
  /// them → relay the Welcome). Idempotent — skips groups that already exist.
  Future<void> setShareTargets(Iterable<String> userIds) async {
    _shareTargets
      ..clear()
      ..addAll(userIds);
    for (final target in userIds) {
      await _ensureShareGroup(target);
    }
  }

  Future<void> _ensureShareGroup(String target) async {
    final session = _session;
    if (session == null) return;
    final crypto = _ref.read(cryptoServiceProvider);
    final gid = CryptoService.pairwiseGroupId(session.userId, target);
    if (crypto.hasGroup(gid)) return;
    // Only the lexicographically-smaller party creates the group, so both
    // sides don't each build a rival group for the same pair.
    if (session.userId.compareTo(target) >= 0) return;
    // In-flight guard: the check above and the claim below straddle an await,
    // so without this a re-entrant setShareTargets would claim two KeyPackages
    // and overwrite the group mid-formation (M2 — MLS desync).
    if (!_forming.add(target)) return;
    final api = _ref.read(apiProvider);
    try {
      final claim = await api.claimKeyPackage(session.token, target);
      await crypto.createGroup(gid);
      final add = await crypto.addMember(gid, base64Decode(claim.keyPackage));
      await api.sendWelcome(
        session.token,
        recipientId: target,
        groupId: utf8.decode(gid),
        payload: base64Encode(add.welcome),
      );
    } on Object catch (e) {
      if (kDebugMode) debugPrint('form share group with $target failed: $e');
    } finally {
      _forming.remove(target);
    }
  }

  Future<void> _onLocalFix(Fix fix) async {
    final session = _session;
    final ws = _ws;
    if (session == null || ws == null) return;
    final crypto = _ref.read(cryptoServiceProvider);
    final payload = utf8.encode(jsonEncode({
      'lat': fix.lat,
      'lon': fix.lon,
      'speed': fix.speed,
      'timestamp': fix.timestampMs,
    }));
    // Snapshot: setShareTargets can mutate the set across the encrypt await
    // (M3 — ConcurrentModificationError).
    for (final target in _shareTargets.toList()) {
      final gid = CryptoService.pairwiseGroupId(session.userId, target);
      if (!crypto.hasGroup(gid)) continue; // group forms at share-accept time
      try {
        final ct = await crypto.encrypt(gid, Uint8List.fromList(payload));
        final frame = jsonEncode({
          'type': 'location.update',
          'recipient_type': 'user',
          'recipient_id': target,
          'blob': base64Encode(ct),
          'timestamp': fix.timestampMs,
        });
        await ws.send(target, frame);
      } on Object catch (e) {
        if (kDebugMode) debugPrint('relay encrypt/send failed: $e');
      }
    }
  }

  Future<void> _onIncoming(Map<String, dynamic> msg) async {
    switch (msg['type']) {
      case 'location.broadcast':
        await _onBroadcast(msg);
      case 'mls.message':
        await _onMlsMessage(msg);
    }
  }

  Future<void> _onBroadcast(Map<String, dynamic> msg) async {
    final session = _session;
    final sender = msg['sender_id'] as String?;
    final blob = msg['blob'] as String?;
    if (session == null || sender == null || blob == null) return;
    final crypto = _ref.read(cryptoServiceProvider);
    final gid = CryptoService.pairwiseGroupId(session.userId, sender);
    if (!crypto.hasGroup(gid)) return;
    try {
      final pt = await crypto.decrypt(gid, base64Decode(blob));
      final data = jsonDecode(utf8.decode(pt)) as Map<String, dynamic>;
      _peerFixes.add(PeerFix(userId: sender, data: data));
    } on Object catch (e) {
      if (kDebugMode) debugPrint('peer fix decrypt failed: $e');
    }
  }

  Future<void> _drainPendingWelcomes() async {
    final session = _session;
    if (session == null) return;
    final api = _ref.read(apiProvider);
    try {
      final msgs = await api.mlsMessages(session.token);
      for (final m in msgs.where((m) => m['message_type'] == 'welcome')) {
        await _applyWelcome(m);
      }
    } on Object catch (e) {
      if (kDebugMode) debugPrint('drain welcomes failed: $e');
    }
  }

  Future<void> _onMlsMessage(Map<String, dynamic> msg) async {
    // The server pushes a lightweight notice; pull the authoritative mailbox.
    await _drainPendingWelcomes();
  }

  Future<void> _applyWelcome(Map<String, dynamic> m) async {
    final session = _session;
    if (session == null) return;
    final api = _ref.read(apiProvider);
    final crypto = _ref.read(cryptoServiceProvider);
    try {
      await crypto.processWelcome(base64Decode(m['payload'] as String));
      await api.ackMlsMessage(session.token, m['id'] as String);
    } on Object catch (e) {
      if (kDebugMode) debugPrint('apply welcome failed: $e');
    }
  }

  Future<void> stop() async {
    await _fixSub?.cancel();
    _fixSub = null;
    await _wsSub?.cancel();
    _wsSub = null;
    await _ws?.dispose();
    _ws = null;
    _session = null;
    _shareTargets.clear();
  }

  Future<void> dispose() async {
    await stop();
    await _peerFixes.close();
  }

  String _wsUrlFor(String base) => '${base.replaceFirst('http', 'ws')}/ws';
}

final relayControllerProvider = Provider<RelayController>((ref) {
  final c = RelayController(ref);
  ref.onDispose(() => unawaited(c.dispose()));
  return c;
});

/// Latest decrypted position per peer, fed by the relay's `peerFixes` (H2 — the
/// receive path now terminates somewhere the map watches, not a dead stream).
/// Keyed by peer user id.
class LivePresence extends Notifier<Map<String, PeerFix>> {
  @override
  Map<String, PeerFix> build() {
    final sub = _ref().peerFixes.listen((fix) {
      state = {...state, fix.userId: fix};
    });
    ref.onDispose(sub.cancel);
    return const {};
  }

  RelayController _ref() => ref.read(relayControllerProvider);
}

final livePresenceProvider =
    NotifierProvider<LivePresence, Map<String, PeerFix>>(LivePresence.new);

/// Persists the relay queue in secure storage, namespaced per user.
class _SecureRelayStore implements RelayStore {
  _SecureRelayStore(this.userId);
  final String userId;
  final _storage = const FlutterSecureStorage();
  String get _key => 'point.relay.queue.$userId';

  @override
  Future<String?> read() => _storage.read(key: _key);
  @override
  Future<void> write(String value) => _storage.write(key: _key, value: value);
}
