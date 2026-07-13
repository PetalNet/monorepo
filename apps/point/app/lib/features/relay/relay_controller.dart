import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/crypto/crypto_service.dart';
import 'package:point_app/features/location/data/location_service.dart';
import 'package:point_app/features/location/location_providers.dart';
import 'package:point_app/features/people/people_controller.dart';
import 'package:point_app/features/relay/domain/realtime_sync_models.dart';
import 'package:point_app/features/relay/relay_queue.dart';
import 'package:point_app/features/relay/ws_service.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/services/server_config.dart';

final cryptoServiceProvider = Provider<CryptoService>((_) => CryptoService());

/// A decrypted location fix from a peer (surfaced to the map/People layer).
class PeerFix {
  const PeerFix({required this.userId, required this.data, this.receivedAt});
  final String userId;
  final Map<String, dynamic> data;
  final DateTime? receivedAt;

  double? get lat => (data['lat'] as num?)?.toDouble();
  double? get lon => (data['lon'] as num?)?.toDouble();
  int? get timestamp => (data['timestamp'] as num?)?.toInt();
}

/// The server's privacy-filtered liveness signal for a peer. `online: false`
/// deliberately carries no cause: ghosting, a dead phone, and lost signal all
/// become the same neutral dark state in the presentation layer.
class PeerPresence {
  const PeerPresence({
    required this.userId,
    required this.online,
    required this.observedAt,
    this.battery,
    this.activity,
  });

  factory PeerPresence.fromFrame(
    Map<String, dynamic> frame, {
    DateTime? observedAt,
  }) {
    final userId = frame['user_id'];
    final online = frame['online'];
    final serverObservedAt = frame['observed_at'];
    if (userId is! String || userId.isEmpty || online is! bool) {
      throw const FormatException('invalid presence.update');
    }
    return PeerPresence(
      userId: userId,
      online: online,
      observedAt: serverObservedAt is num
          ? DateTime.fromMillisecondsSinceEpoch(serverObservedAt.toInt())
          : observedAt ?? DateTime.now(),
      battery: frame['battery'] is num ? frame['battery'] as num : null,
      activity: frame['activity'] is String
          ? frame['activity'] as String
          : null,
    );
  }

  final String userId;
  final bool online;
  final DateTime observedAt;
  final num? battery;
  final String? activity;
}

/// Previous and target fixes for one live marker, including both the sender's
/// sample time and our receipt time. The presentation layer owns interpolation;
/// relay ordering remains based solely on the signed payload timestamp.
class PeerMarkerMotion {
  const PeerMarkerMotion._({
    required this.previous,
    required this.target,
    required this.glideDuration,
  });

  factory PeerMarkerMotion.initial(PeerFix target) => PeerMarkerMotion._(
    previous: null,
    target: target,
    glideDuration: Duration.zero,
  );

  static const _minimumGlide = Duration(milliseconds: 180);
  static const _maximumGlide = Duration(milliseconds: 800);
  static const _staleAfter = Duration(minutes: 3);
  static const _maximumPlausibleSpeedMetersPerSecond = 120.0;

  final PeerFix? previous;
  final PeerFix target;
  final Duration glideDuration;

  PeerMarkerMotion advance(PeerFix next, {DateTime? now}) {
    final previousTimestamp = target.timestamp;
    final nextTimestamp = next.timestamp;
    final interval = previousTimestamp == null || nextTimestamp == null
        ? null
        : Duration(milliseconds: nextTimestamp - previousTimestamp);
    final received = next.receivedAt ?? now ?? DateTime.now();
    final sourceAt = nextTimestamp == null
        ? received
        : DateTime.fromMillisecondsSinceEpoch(nextTimestamp);
    final age = (now ?? received).difference(sourceAt);
    final distance = _distanceMeters(target, next);
    final seconds = interval == null ? 0.0 : interval.inMilliseconds / 1000;
    final impossible =
        distance == null ||
        seconds <= 0 ||
        distance / seconds > _maximumPlausibleSpeedMetersPerSecond;
    final stale =
        age > _staleAfter ||
        age.isNegative ||
        (interval != null && interval > _staleAfter);

    if (interval == null || impossible || stale) {
      return PeerMarkerMotion._(
        previous: target,
        target: next,
        glideDuration: Duration.zero,
      );
    }

    final cadencePortion = interval.inMilliseconds ~/ 4;
    final boundedMilliseconds = cadencePortion.clamp(
      _minimumGlide.inMilliseconds,
      _maximumGlide.inMilliseconds,
    );
    return PeerMarkerMotion._(
      previous: target,
      target: next,
      glideDuration: Duration(milliseconds: boundedMilliseconds),
    );
  }

  Duration duration({required bool reducedMotion}) =>
      reducedMotion ? Duration.zero : glideDuration;

  static double? _distanceMeters(PeerFix from, PeerFix to) {
    final lat1 = from.lat;
    final lon1 = from.lon;
    final lat2 = to.lat;
    final lon2 = to.lon;
    if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) {
      return null;
    }
    const earthRadiusMeters = 6371000.0;
    double radians(double degrees) => degrees * math.pi / 180;
    final deltaLat = radians(lat2 - lat1);
    final deltaLon = radians(lon2 - lon1);
    final a =
        math.sin(deltaLat / 2) * math.sin(deltaLat / 2) +
        math.cos(radians(lat1)) *
            math.cos(radians(lat2)) *
            math.sin(deltaLon / 2) *
            math.sin(deltaLon / 2);
    return earthRadiusMeters * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a));
  }
}

/// Assembles the verified M2 pieces into the shipping relay path:
/// - on sign-in: init MLS (durable), top up the one-time KeyPackage POOL,
///   connect the durable WS, and process any pending Welcomes;
/// - outbound: each LocationService fix is MLS-encrypted per accepted share and
///   sent through the durable queue;
/// - inbound: `mls.message` Welcomes join groups; `location.broadcast` frames
///   are decrypted and surfaced as [PeerFix]es.
class RelayController {
  RelayController(
    this._ref, {
    FlutterSecureStorage? storage,
    WsService Function(String wsUrl, RelayQueue queue)? wsFactory,
  }) : _storage = storage ?? const FlutterSecureStorage(),
       _wsFactory = wsFactory;

  final Ref _ref;
  final FlutterSecureStorage _storage;
  final WsService Function(String wsUrl, RelayQueue queue)? _wsFactory;
  WsService? _ws;
  StreamSubscription<Fix>? _fixSub;
  StreamSubscription<Map<String, dynamic>>? _wsSub;
  StreamSubscription<WsConnectionState>? _wsStateSub;
  Session? _session;
  int _sessionEpoch = 0;
  Future<void> _lifecycleTail = Future<void>.value();
  Future<void> _sessionWorkTail = Future<void>.value();

  /// Server ids of peers we currently share with (their pairwise groups).
  final Set<String> _shareTargets = {};

  /// Targets whose group formation is in flight — prevents a re-entrant
  /// `setShareTargets` from double-claiming KeyPackages / overwriting the group
  /// (M2). Cleared when formation finishes.
  final Set<String> _forming = {};
  final Map<String, DateTime> _peerRekeyedAt = {};
  final Map<String, DateTime> _shareSince = {};
  DateTime? _selfRekeyedAt;
  Future<void>? _identityGenerationReady;
  bool _generationRetryScheduled = false;
  final _peerFixes = StreamController<PeerFix>.broadcast();
  final _peerPresenceUpdates =
      StreamController<Map<String, PeerPresence>>.broadcast();
  final _syncRequests = StreamController<RealtimeSyncReason>.broadcast();
  final Map<String, int> _latestFixTimestamp = {};
  final Map<String, PeerPresence> _peerPresenceByUser = {};
  final Map<String, Map<String, int>> _mailboxFailuresByUser = {};

  /// Decrypted peer fixes for the presence/map layer.
  Stream<PeerFix> get peerFixes => _peerFixes.stream;

  /// Presence events received so far, including peers without a location fix.
  Map<String, PeerPresence> get peerPresence =>
      Map.unmodifiable(_peerPresenceByUser);

  Stream<Map<String, PeerPresence>> get peerPresenceUpdates =>
      _peerPresenceUpdates.stream;

  Stream<RealtimeSyncReason> get syncRequests => _syncRequests.stream;

  int get sessionEpoch => _sessionEpoch;

  bool isSessionCurrent(int epoch, String userId) =>
      epoch == _sessionEpoch && _session?.userId == userId;

  static const _poolFloor = 5;

  Future<void> start(Session session) => _queueLifecycle(() => _start(session));

  Future<void> _start(Session session) async {
    // Defensive idempotence: a repeat start for the same session is a no-op,
    // and a different session tears the old stack down first. Without this a
    // re-entrant start stacks WS/fix subscriptions and double-processes MLS
    // messages.
    if (_ws != null) {
      if (_session?.userId == session.userId) return;
      await _stopInternal();
    }
    _sessionEpoch++;
    _session = session;
    final generationReady = Completer<void>();
    _identityGenerationReady = generationReady.future;
    final api = _ref.read(apiProvider);
    final crypto = _ref.read(cryptoServiceProvider);
    final initResult = await crypto.init(session.userId);

    // Top up the one-time KeyPackage pool (multi-KP; GO-bar #4). On a re-key
    // (wiped state) the server still lists our OLD packages whose private
    // halves are gone, so we must force a fresh pool regardless of the count —
    // otherwise peers claim stale packages and silently can't reach us (H1).
    try {
      if (initResult != MlsInit.restored) {
        // Created can mean a genuinely new account OR an existing account on
        // a fresh install. In both cases this device has a new MLS identity;
        // every server-stored package from an older install is unusable.
        await reprovisionKeyPackages();
      } else {
        final count = await api.keyCount(session.token);
        if (count.available < _poolFloor) {
          final pool = [
            for (var i = 0; i < _poolFloor; i++)
              base64Encode(await crypto.generateKeyPackage()),
          ];
          await api.uploadKeyPackages(session.token, pool);
        }
      }
      // Both sides compare identity generations to select exactly one rekey
      // initiator: the older identity consumes the newer identity's package.
      _selfRekeyedAt = (await api.keyCount(session.token)).rekeyedAt;
    } on Object catch (e) {
      if (kDebugMode) debugPrint('keypackage top-up failed: $e');
    } finally {
      // setShareTargets can race session startup. Never choose a formation
      // direction until our own generation lookup has finished, or a newly
      // registered lexicographically-smaller user can initiate the rival group
      // before learning that its identity is the newer one.
      generationReady.complete();
    }

    // Durable WS (survives disconnect; jittered reconnect).
    await _loadFixCursors(session.userId);
    final wsUrl = _wsUrlFor(_ref.read(serverUrlProvider));
    final queue = RelayQueue(store: _SecureRelayStore(session.userId));
    final ws =
        _wsFactory?.call(wsUrl, queue) ?? WsService(wsUrl: wsUrl, queue: queue);
    _ws = ws;
    _wsSub = ws.incoming.listen(_onIncoming);
    _wsStateSub = ws.connectionStates.listen((state) {
      if (state == WsConnectionState.authenticated) {
        _requestSync(RealtimeSyncReason.wsAuthenticated);
      } else if (state == WsConnectionState.disconnected) {
        _clearPeerPresence();
      }
    });
    await ws.start(session.token);

    // Relay each local fix, encrypted per share.
    _fixSub = _ref.read(locationServiceProvider).fixes.listen(_onLocalFix);
  }

  /// Replace the server-side KeyPackage pool with a fresh one from the
  /// CURRENT crypto identity. Called after any identity replacement (wiped
  /// local state, a recovery restore, or enrolling fresh over an old backup):
  /// packages minted by the previous identity are unusable, and a peer
  /// claiming one would silently never reach us.
  Future<void> reprovisionKeyPackages() async {
    final session = _session;
    if (session == null) return;
    final crypto = _ref.read(cryptoServiceProvider);
    final pool = [
      for (var i = 0; i < _poolFloor; i++)
        base64Encode(await crypto.generateKeyPackage()),
    ];
    await _ref
        .read(apiProvider)
        .uploadKeyPackages(session.token, pool, replace: true);
  }

  /// Track who we share with; for any new target we don't yet have a group
  /// with, form one (claim their KeyPackage → create the pairwise group → add
  /// them → relay the Welcome). Idempotent — skips groups that already exist.
  ///
  /// [forceInitiate] are targets I must form the group with UNCONDITIONALLY —
  /// one-way temp-share recipients. The usual lexicographic tie-break only makes
  /// sense for a MUTUAL share (both sides list each other, so the smaller always
  /// initiates); a one-way temp is asymmetric — only the sharer lists the peer,
  /// so if I'm the larger id and defer, no one ever forms the group and the
  /// recipient silently gets nothing.
  Future<void> setShareTargets(
    Iterable<String> userIds, {
    Set<String> forceInitiate = const {},
    Map<String, DateTime> peerRekeyedAt = const {},
    Map<String, DateTime> shareSince = const {},
  }) async {
    _shareTargets
      ..clear()
      ..addAll(userIds);
    _peerRekeyedAt
      ..clear()
      ..addAll(peerRekeyedAt);
    _shareSince
      ..clear()
      ..addAll(shareSince);
    for (final target in userIds) {
      await _ensureShareGroup(
        target,
        force: forceInitiate.contains(target),
        rekeyedAt: peerRekeyedAt[target],
        shareSince: shareSince[target],
      );
    }
  }

  Future<void> _ensureShareGroup(
    String target, {
    bool force = false,
    DateTime? rekeyedAt,
    DateTime? shareSince,
  }) async {
    await _identityGenerationReady;
    final session = _session;
    if (session == null) return;
    final api = _ref.read(apiProvider);
    if (_selfRekeyedAt == null) {
      try {
        _selfRekeyedAt = (await api.keyCount(session.token)).rekeyedAt;
      } on Object {
        _scheduleGenerationRetry();
        return;
      }
    }
    final crypto = _ref.read(cryptoServiceProvider);
    final gid = CryptoService.pairwiseGroupId(session.userId, target);
    final handled = await _readHandledFormation(session.userId, target);
    final shouldInitiate = shouldInitiatePairwiseGroup(
      selfUserId: session.userId,
      peerUserId: target,
      hasGroup: crypto.hasGroup(gid),
      peerRekeyedAt: rekeyedAt,
      selfRekeyedAt: _selfRekeyedAt,
      shareSince: shareSince,
      handledPeerRekeyedAt: handled.peerRekeyedAt,
      handledShareSince: handled.shareSince,
      forceInitiate: force,
    );
    // One authority selects formation/rekey direction. Reapplying the old
    // username gate here vetoed the generation decision for petalcat > janet.
    if (!shouldInitiate) return;
    // In-flight guard: the check above and the claim below straddle an await,
    // so without this a re-entrant setShareTargets would claim two KeyPackages
    // and overwrite the group mid-formation (M2 — MLS desync).
    if (!_forming.add(target)) return;
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
      await _writeHandledFormation(
        session.userId,
        target,
        peerRekeyedAt: rekeyedAt,
        shareSince: shareSince,
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
    final payload = utf8.encode(
      jsonEncode({
        'lat': fix.lat,
        'lon': fix.lon,
        'speed': fix.speed,
        'timestamp': fix.timestampMs,
      }),
    );
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
      case 'presence.update':
        _onPresenceUpdate(msg);
      case 'mls.message':
        _requestSync(RealtimeSyncReason.mailboxNotice);
      case 'share.request':
        _requestSync(RealtimeSyncReason.shareRequest);
      case 'share.accepted':
        // A request either party sent was accepted → the shares list changed.
        // Refresh both so the pinned request clears and the new person appears
        // (the relay's setShareTargets then forms the MLS group with them).
        _requestSync(RealtimeSyncReason.relayEvent);
      case 'peer.rekeyed':
        // Pull the authoritative generation marker; the deterministic
        // initiator will replace the stale group and emit a fresh Welcome.
        _requestSync(RealtimeSyncReason.relayEvent);
      case 'share.removed':
        final peer = msg['user_id'] as String?;
        if (peer != null) {
          // Stop encrypting immediately, and remove both the accepted-person
          // row and cached fix before the refresh round-trip finishes.
          removeRelayTarget(
            peer,
            targets: _shareTargets,
            peerRekeyedAt: _peerRekeyedAt,
            shareSince: _shareSince,
          );
          _ref.read(peopleControllerProvider.notifier).removeLocally(peer);
          _ref.read(livePresenceProvider.notifier).remove(peer);
          _peerPresenceByUser.remove(peer);
          _emitPeerPresence();
        }
        _requestSync(RealtimeSyncReason.relayEvent);
      case 'share.temp_created':
        // Someone started a temp share to me (or the server confirmed mine).
        _requestSync(RealtimeSyncReason.relayEvent);
    }
  }

  void _onPresenceUpdate(Map<String, dynamic> frame) {
    try {
      final presence = PeerPresence.fromFrame(frame);
      final current = _peerPresenceByUser[presence.userId];
      if (current != null && presence.observedAt.isBefore(current.observedAt)) {
        return;
      }
      _peerPresenceByUser[presence.userId] = presence;
      _emitPeerPresence();
    } on FormatException {
      // Presence is advisory and unencrypted. Ignore malformed frames rather
      // than allowing them to corrupt the trusted location state.
    }
  }

  void _emitPeerPresence() {
    if (!_peerPresenceUpdates.isClosed) {
      _peerPresenceUpdates.add(Map.unmodifiable(_peerPresenceByUser));
    }
  }

  void _clearPeerPresence() {
    if (_peerPresenceByUser.isEmpty) return;
    _peerPresenceByUser.clear();
    _emitPeerPresence();
  }

  void _requestSync(RealtimeSyncReason reason) {
    if (!_syncRequests.isClosed) _syncRequests.add(reason);
  }

  void _scheduleGenerationRetry() {
    if (_generationRetryScheduled) return;
    _generationRetryScheduled = true;
    Future<void>.delayed(const Duration(seconds: 2), () {
      _generationRetryScheduled = false;
      if (_session != null) _requestSync(RealtimeSyncReason.relayEvent);
    });
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
      await _acceptPeerFix(sender, data);
    } on Object catch (e) {
      if (kDebugMode) debugPrint('peer fix decrypt failed: $e');
    }
  }

  /// Drain the authoritative MLS mailbox oldest-first. Durable crypto state and
  /// the local applied-id marker are committed atomically by [CryptoService]
  /// before the server row is ACKed. A poison row blocks only its own group;
  /// after three failed sync passes it is quarantined server-side so later
  /// commits can make progress without falsely marking the poison as applied.
  Future<MailboxDrainDiff> processMailbox() =>
      _queueSessionWork(_processMailbox);

  Future<MailboxDrainDiff> _processMailbox() async {
    final session = _session;
    if (session == null) return const MailboxDrainDiff();
    final epoch = _sessionEpoch;
    final api = _ref.read(apiProvider);
    final crypto = _ref.read(cryptoServiceProvider);
    final failures = await _readMailboxFailures(session.userId);
    var applied = 0;
    var alreadyApplied = 0;
    var acknowledged = 0;
    var quarantined = 0;
    var deferred = 0;
    final errors = <RealtimeSyncFailure>[];
    final quarantinedMessageIds = <String>{};
    final blockedGroups = <String>{};
    try {
      final messages = await api.mlsMessages(session.token)
        ..sort((a, b) {
          final created = (a['created_at'] as String? ?? '').compareTo(
            b['created_at'] as String? ?? '',
          );
          if (created != 0) return created;
          return (a['id'] as String? ?? '').compareTo(b['id'] as String? ?? '');
        });
      if (!isSessionCurrent(epoch, session.userId)) {
        return const MailboxDrainDiff(
          errors: [RealtimeSyncFailure.sessionChanged],
        );
      }
      for (final message in messages) {
        if (!isSessionCurrent(epoch, session.userId)) {
          return MailboxDrainDiff(
            applied: applied,
            alreadyApplied: alreadyApplied,
            acknowledged: acknowledged,
            quarantined: quarantined,
            deferred: deferred,
            errors: const [RealtimeSyncFailure.sessionChanged],
          );
        }
        final id = message['id'] as String?;
        final type = message['message_type'] as String?;
        final groupId = message['group_id'] as String?;
        final payload = message['payload'] as String?;
        if (id == null || type == null || groupId == null || payload == null) {
          if (id != null &&
              await _quarantine(
                session.token,
                id,
                reason: 'malformed_envelope',
              )) {
            quarantined++;
            quarantinedMessageIds.add(id);
          } else {
            errors.add(RealtimeSyncFailure.mailboxMalformed);
          }
          continue;
        }
        if (blockedGroups.contains(groupId)) {
          deferred++;
          continue;
        }
        var appliedDurably = false;
        try {
          final bytes = base64Decode(payload);
          final MailboxApplyResult result;
          switch (type) {
            case 'welcome':
              result = await crypto.processMailboxWelcome(id, bytes);
            case 'commit':
              result = await crypto.processMailboxCommit(
                id,
                CryptoService.groupIdFor(groupId),
                bytes,
              );
            default:
              if (await _quarantine(
                session.token,
                id,
                reason: 'unknown_message_type',
              )) {
                quarantined++;
                quarantinedMessageIds.add(id);
                failures.remove(id);
                continue;
              }
              throw const FormatException('unknown mailbox message type');
          }
          appliedDurably = true;
          if (result == MailboxApplyResult.applied) {
            applied++;
          } else {
            alreadyApplied++;
          }
          await api.ackMlsMessage(session.token, id);
          acknowledged++;
          failures.remove(id);
          try {
            await crypto.markMailboxAcknowledged(id);
          } on Object catch (e) {
            // An extra replay guard is safe; losing it before ACK is not.
            if (kDebugMode) debugPrint('clear mailbox receipt $id failed: $e');
          }
          if (type == 'welcome') {
            try {
              await _recordWelcomeFormation(message);
            } on Object catch (e) {
              if (kDebugMode) {
                debugPrint('persist Welcome formation marker failed: $e');
              }
            }
          }
        } on FormatException {
          if (await _quarantine(
            session.token,
            id,
            reason: 'malformed_payload',
          )) {
            quarantined++;
            quarantinedMessageIds.add(id);
            failures.remove(id);
          } else {
            blockedGroups.add(groupId);
            errors.add(RealtimeSyncFailure.mailboxQuarantineFailed);
          }
        } on Object catch (e) {
          if (appliedDurably) {
            // ACK failed after crypto+marker persistence. Never process or
            // quarantine this valid message again; the next drain recognizes
            // its local id and retries only the idempotent ACK.
            blockedGroups.add(groupId);
            errors.add(RealtimeSyncFailure.mailboxAckFailed);
            continue;
          }
          final count = (failures[id] ?? 0) + 1;
          failures[id] = count;
          if (count >= 3 &&
              await _quarantine(
                session.token,
                id,
                reason: 'crypto_rejected',
              )) {
            quarantined++;
            quarantinedMessageIds.add(id);
            failures.remove(id);
          } else {
            blockedGroups.add(groupId);
            errors.add(RealtimeSyncFailure.mailboxApplyFailed);
            if (kDebugMode) debugPrint('apply MLS mailbox row $id failed: $e');
          }
        }
      }
    } on Object catch (e) {
      errors.add(RealtimeSyncFailure.mailboxUnavailable);
      if (kDebugMode) debugPrint('drain MLS mailbox failed: $e');
    }
    if (!await _writeMailboxFailures(session.userId, failures)) {
      errors.add(RealtimeSyncFailure.mailboxFailureStateUnavailable);
    }
    return MailboxDrainDiff(
      applied: applied,
      alreadyApplied: alreadyApplied,
      acknowledged: acknowledged,
      quarantined: quarantined,
      quarantinedMessageIds: quarantinedMessageIds,
      deferred: deferred,
      errors: errors,
    );
  }

  Future<bool> _quarantine(
    String token,
    String id, {
    required String reason,
  }) async {
    try {
      await _ref
          .read(apiProvider)
          .quarantineMlsMessage(token, id, reason: reason);
      return true;
    } on Object {
      return false;
    }
  }

  Future<void> _recordWelcomeFormation(Map<String, dynamic> message) async {
    final session = _session;
    if (session == null) return;
    final sender = message['sender_id'] as String?;
    final generation = sender == null ? null : _peerRekeyedAt[sender];
    final since = sender == null ? null : _shareSince[sender];
    if (sender != null) {
      await _writeHandledFormation(
        session.userId,
        sender,
        peerRekeyedAt: generation,
        shareSince: since,
      );
    }
  }

  Future<CurrentFixSyncDiff> reconcileCurrentFixes(
    Iterable<String> peerUserIds,
  ) => _queueSessionWork(() => _reconcileCurrentFixes(peerUserIds));

  Future<CurrentFixSyncDiff> _reconcileCurrentFixes(
    Iterable<String> peerUserIds,
  ) async {
    final session = _session;
    if (session == null) return const CurrentFixSyncDiff();
    final epoch = _sessionEpoch;
    final api = _ref.read(apiProvider);
    final crypto = _ref.read(cryptoServiceProvider);
    final updated = <String>{};
    final errors = <RealtimeSyncFailure>[];
    for (final peerUserId in peerUserIds.toSet()) {
      try {
        final rows = await api.currentFixes(session.token, peerUserId);
        if (!isSessionCurrent(epoch, session.userId)) {
          return const CurrentFixSyncDiff(
            errors: [RealtimeSyncFailure.sessionChanged],
          );
        }
        for (final row in rows) {
          if (row.clientTimestamp <= (_latestFixTimestamp[peerUserId] ?? 0)) {
            continue;
          }
          final groupId = row.recipientType == 'group'
              ? CryptoService.groupIdFor(row.recipientId)
              : CryptoService.pairwiseGroupId(session.userId, peerUserId);
          if (!crypto.hasGroup(groupId)) continue;
          final plaintext = await crypto.decrypt(
            groupId,
            base64Decode(row.blob),
          );
          final data =
              jsonDecode(utf8.decode(plaintext)) as Map<String, dynamic>;
          if (await _acceptPeerFix(peerUserId, data)) {
            updated.add(peerUserId);
          }
        }
      } on Object catch (e) {
        errors.add(RealtimeSyncFailure.currentFixFailed);
        if (kDebugMode) {
          debugPrint('current fix reconcile for $peerUserId failed: $e');
        }
      }
    }
    return CurrentFixSyncDiff(updatedPeers: updated, errors: errors);
  }

  Future<bool> _acceptPeerFix(
    String userId,
    Map<String, dynamic> data,
  ) async {
    final timestamp = data['timestamp'] as int? ?? 0;
    if (timestamp <= (_latestFixTimestamp[userId] ?? 0)) return false;
    _latestFixTimestamp[userId] = timestamp;
    _peerFixes.add(
      PeerFix(userId: userId, data: data, receivedAt: DateTime.now()),
    );
    final session = _session;
    if (session != null) await _writeFixCursors(session.userId);
    return true;
  }

  String _mailboxFailuresKey(String userId) =>
      'point.mls.mailbox.failures.$userId';

  Future<Map<String, int>> _readMailboxFailures(String userId) async {
    final inMemory = _mailboxFailuresByUser.putIfAbsent(userId, () => {});
    try {
      final raw = await _storage.read(key: _mailboxFailuresKey(userId));
      if (raw == null) return Map.of(inMemory);
      final json = jsonDecode(raw) as Map<String, dynamic>;
      for (final entry in json.entries) {
        final stored = entry.value as int;
        if (stored > (inMemory[entry.key] ?? 0)) inMemory[entry.key] = stored;
      }
      return Map.of(inMemory);
    } on Object {
      return Map.of(inMemory);
    }
  }

  Future<bool> _writeMailboxFailures(
    String userId,
    Map<String, int> failures,
  ) async {
    _mailboxFailuresByUser[userId] = Map.of(failures);
    try {
      await _storage.write(
        key: _mailboxFailuresKey(userId),
        value: jsonEncode(failures),
      );
      return true;
    } on Object catch (e) {
      if (kDebugMode) debugPrint('persist mailbox failures failed: $e');
      return false;
    }
  }

  String _fixCursorsKey(String userId) => 'point.relay.fix-cursors.$userId';

  Future<void> _loadFixCursors(String userId) async {
    _latestFixTimestamp.clear();
    _clearPeerPresence();
    try {
      final raw = await _storage.read(key: _fixCursorsKey(userId));
      if (raw == null) return;
      final json = jsonDecode(raw) as Map<String, dynamic>;
      _latestFixTimestamp.addAll(
        json.map((peer, timestamp) => MapEntry(peer, timestamp as int)),
      );
    } on Object catch (e) {
      if (kDebugMode) debugPrint('load current-fix cursors failed: $e');
    }
  }

  Future<void> _writeFixCursors(String userId) async {
    try {
      await _storage.write(
        key: _fixCursorsKey(userId),
        value: jsonEncode(_latestFixTimestamp),
      );
    } on Object catch (e) {
      if (kDebugMode) debugPrint('persist current-fix cursors failed: $e');
    }
  }

  Future<T> _queueSessionWork<T>(Future<T> Function() action) {
    final completer = Completer<T>();
    _sessionWorkTail = _sessionWorkTail.catchError((Object _) {}).then((
      _,
    ) async {
      try {
        completer.complete(await action());
      } on Object catch (error, stackTrace) {
        completer.completeError(error, stackTrace);
      }
    });
    return completer.future;
  }

  Future<void> _queueLifecycle(Future<void> Function() action) {
    final completer = Completer<void>();
    _lifecycleTail = _lifecycleTail.catchError((Object _) {}).then((_) async {
      try {
        await action();
        completer.complete();
      } on Object catch (error, stackTrace) {
        completer.completeError(error, stackTrace);
      }
    });
    return completer.future;
  }

  Future<void> stop() => _queueLifecycle(_stopInternal);

  Future<void> _stopInternal() async {
    _sessionEpoch++;
    await _sessionWorkTail.catchError((Object _) {});
    await _fixSub?.cancel();
    _fixSub = null;
    await _wsSub?.cancel();
    _wsSub = null;
    await _wsStateSub?.cancel();
    _wsStateSub = null;
    await _ws?.dispose();
    _ws = null;
    _session = null;
    _shareTargets.clear();
    _peerRekeyedAt.clear();
    _shareSince.clear();
    _selfRekeyedAt = null;
    _identityGenerationReady = null;
    _generationRetryScheduled = false;
    _latestFixTimestamp.clear();
    _clearPeerPresence();
  }

  Future<void> dispose() async {
    await stop();
    await _peerFixes.close();
    await _peerPresenceUpdates.close();
    await _syncRequests.close();
  }

  String _wsUrlFor(String base) => '${base.replaceFirst('http', 'ws')}/ws';
}

/// True when this client is responsible for replacing a stale pairwise group.
/// Mutual shares have one deterministic initiator; one-way temporary shares
/// force the sharer to initiate because the recipient has no outbound target.
bool shouldInitiatePairwiseGroup({
  required String selfUserId,
  required String peerUserId,
  required bool hasGroup,
  required DateTime? peerRekeyedAt,
  required DateTime? selfRekeyedAt,
  required DateTime? shareSince,
  required DateTime? handledPeerRekeyedAt,
  required DateTime? handledShareSince,
  bool forceInitiate = false,
}) {
  final peerChanged =
      peerRekeyedAt != null &&
      (handledPeerRekeyedAt == null ||
          peerRekeyedAt.isAfter(handledPeerRekeyedAt));
  final shareChanged =
      shareSince != null &&
      (handledShareSince == null || shareSince.isAfter(handledShareSince));
  if (forceInitiate) return !hasGroup || peerChanged || shareChanged;
  if (hasGroup && !peerChanged && !shareChanged) return false;

  // Without our own generation, choosing by username can race a peer that did
  // load the generations and selected itself. Fail closed; a later sharing
  // refresh retries after key-count succeeds.
  if (selfRekeyedAt == null) return false;

  // The side with the older identity must consume the newer side's CURRENT
  // package. This is the task-726 acceptance tell (fresh Janet KP consumed),
  // and prevents a newly installed device racing its peer with a rival group.
  if (peerChanged) {
    if (selfRekeyedAt.isBefore(peerRekeyedAt)) return true;
    if (selfRekeyedAt.isAfter(peerRekeyedAt)) return false;
  }

  // Migration backfill gives existing peers an equal generation. Preserve the
  // established deterministic tie-break so exactly one side heals the group.
  return selfUserId.compareTo(peerUserId) < 0;
}

/// Mutates the relay's live audience state in the same turn as a
/// `share.removed` frame, before any network refresh can race another fix.
void removeRelayTarget(
  String peer, {
  required Set<String> targets,
  required Map<String, DateTime> peerRekeyedAt,
  required Map<String, DateTime> shareSince,
}) {
  targets.remove(peer);
  peerRekeyedAt.remove(peer);
  shareSince.remove(peer);
}

Map<String, T> withoutPeerFix<T>(
  Map<String, T> fixes,
  String userId,
) => {...fixes}..remove(userId);

const _formationMarkerPrefix = 'point.mls.pair-formation.';

typedef _HandledFormation = ({
  DateTime? peerRekeyedAt,
  DateTime? shareSince,
});

Future<_HandledFormation> _readHandledFormation(
  String self,
  String peer,
) async {
  const storage = FlutterSecureStorage();
  final values = await Future.wait([
    storage.read(key: '$_formationMarkerPrefix$self.$peer.peer'),
    storage.read(key: '$_formationMarkerPrefix$self.$peer.share'),
  ]);
  return (
    peerRekeyedAt: DateTime.tryParse(values[0] ?? ''),
    shareSince: DateTime.tryParse(values[1] ?? ''),
  );
}

Future<void> _writeHandledFormation(
  String self,
  String peer, {
  required DateTime? peerRekeyedAt,
  required DateTime? shareSince,
}) async {
  const storage = FlutterSecureStorage();
  await Future.wait([
    if (peerRekeyedAt != null)
      storage.write(
        key: '$_formationMarkerPrefix$self.$peer.peer',
        value: peerRekeyedAt.toUtc().toIso8601String(),
      ),
    if (shareSince != null)
      storage.write(
        key: '$_formationMarkerPrefix$self.$peer.share',
        value: shareSince.toUtc().toIso8601String(),
      ),
  ]);
}

final relayControllerProvider = Provider<RelayController>((ref) {
  final c = RelayController(ref);
  ref.onDispose(() => unawaited(c.dispose()));
  return c;
});

/// Latest decrypted position per peer, fed by the relay's `peerFixes` (H2 — the
/// receive path now terminates somewhere the map watches, not a dead stream).
/// Keyed by peer user id.
class LivePresence extends Notifier<Map<String, PeerMarkerMotion>> {
  @override
  Map<String, PeerMarkerMotion> build() {
    final sub = _ref().peerFixes.listen((fix) {
      final current = state[fix.userId];
      state = {
        ...state,
        fix.userId: current == null
            ? PeerMarkerMotion.initial(fix)
            : current.advance(fix),
      };
    });
    ref.onDispose(sub.cancel);
    return const {};
  }

  RelayController _ref() => ref.read(relayControllerProvider);

  void remove(String userId) {
    if (!state.containsKey(userId)) return;
    state = withoutPeerFix(state, userId);
  }
}

final livePresenceProvider =
    NotifierProvider<LivePresence, Map<String, PeerMarkerMotion>>(
      LivePresence.new,
    );

/// Live server presence keyed by peer id. The controller owns a snapshot so a
/// provider created just after a frame still receives the latest state.
class PeerPresences extends Notifier<Map<String, PeerPresence>> {
  @override
  Map<String, PeerPresence> build() {
    final relay = ref.read(relayControllerProvider);
    final sub = relay.peerPresenceUpdates.listen(
      (presence) => state = presence,
    );
    ref.onDispose(sub.cancel);
    return relay.peerPresence;
  }
}

final peerPresenceProvider =
    NotifierProvider<PeerPresences, Map<String, PeerPresence>>(
      PeerPresences.new,
    );

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
