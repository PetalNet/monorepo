import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/crypto/crypto_service.dart';
import 'package:point_app/features/location/data/location_service.dart';
import 'package:point_app/features/location/location_providers.dart';
import 'package:point_app/features/people/people_controller.dart';
import 'package:point_app/features/people/temp_shares_controller.dart';
import 'package:point_app/features/relay/data/realtime_sync_coordinator.dart';
import 'package:point_app/features/relay/domain/realtime_sync_models.dart';
import 'package:point_app/features/relay/relay_queue.dart';
import 'package:point_app/features/relay/ws_service.dart';
import 'package:point_app/features/settings/app_settings.dart';
import 'package:point_app/features/settings/settings_controller.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/services/server_config.dart';
import 'package:point_app/theme/theme_x.dart';

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
  double? get accuracy {
    final value = (data['accuracy'] as num?)?.toDouble();
    return value != null && value.isFinite && value > 0 ? value : null;
  }
}

/// The plaintext shape encrypted into each pairwise MLS group.
///
/// Accuracy is additive for cross-version compatibility: older clients ignore
/// it, while newer clients continue to accept payloads that predate the field.
Map<String, num> locationFixPayload(Fix fix) => {
  'lat': fix.lat,
  'lon': fix.lon,
  'speed': fix.speed,
  if (fix.accuracy.isFinite && fix.accuracy > 0) 'accuracy': fix.accuracy,
  'timestamp': fix.timestampMs,
};

bool _isValidPeerFix(Map<String, dynamic> data) {
  final lat = (data['lat'] as num?)?.toDouble();
  final lon = (data['lon'] as num?)?.toDouble();
  final timestampValue = data['timestamp'] as num?;
  final timestamp = timestampValue?.toInt();
  return lat != null &&
      lon != null &&
      timestamp != null &&
      timestampValue == timestamp &&
      lat.isFinite &&
      lon.isFinite &&
      lat >= -90 &&
      lat <= 90 &&
      lon >= -180 &&
      lon <= 180 &&
      timestamp > 0;
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

enum RelayHealthStatus {
  connecting,
  live,
  reconnecting,
  offline,
  cryptoBlocked,
}

/// Truthful local relay state for Map/People presentation. [lastSyncAt] is the
/// last successful authoritative catch-up, not merely the last socket frame.
@immutable
class RelayHealth {
  const RelayHealth({
    required this.status,
    required this.queueDepth,
    required this.locationBlocked,
    this.lastSyncAt,
  });

  const RelayHealth.offline()
    : status = RelayHealthStatus.offline,
      queueDepth = 0,
      locationBlocked = false,
      lastSyncAt = null;

  final RelayHealthStatus status;
  final DateTime? lastSyncAt;
  final int queueDepth;
  final bool locationBlocked;

  bool get isLive =>
      status == RelayHealthStatus.live && !locationBlocked && queueDepth == 0;
  bool get isCached => !isLive;
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
  StreamSubscription<WsHealth>? _wsHealthSub;
  StreamSubscription<LocationHealth>? _locationHealthSub;
  StreamSubscription<RealtimeSyncDiff>? _syncDiffSub;
  Session? _session;
  int _sessionEpoch = 0;
  Future<void> _lifecycleTail = Future<void>.value();
  Future<void> _sessionWorkTail = Future<void>.value();
  Future<void> _fixCacheWriteTail = Future<void>.value();
  int _lastPeopleAuthorizationRevision = 0;

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
  final _healthUpdates = StreamController<RelayHealth>.broadcast();
  RelayHealth _health = const RelayHealth.offline();
  WsConnectionState _wsConnection = WsConnectionState.disconnected;
  bool _hasAuthenticated = false;
  bool _syncHealthy = false;
  bool _hasEverSynced = false;
  bool _startupCryptoBlocked = false;
  bool _mailboxCryptoBlocked = false;
  final Set<String> _cryptoBlockedPeers = {};
  final Map<String, int> _latestFixTimestamp = {};
  final Map<String, PeerFix> _cachedPeerFixes = {};
  final Set<String> _permanentCachedPeers = {};
  final Map<String, PeerPresence> _peerPresenceByUser = {};
  final Map<String, Map<String, int>> _mailboxFailuresByUser = {};

  /// Decrypted peer fixes for the presence/map layer.
  Stream<PeerFix> get peerFixes => _peerFixes.stream;

  /// Secure-storage snapshot used when the UI starts listening after relay
  /// initialization. Values remain age-labelled by their signed sample time.
  Map<String, PeerFix> get cachedPeerFixes =>
      Map.unmodifiable(_cachedPeerFixes);

  /// Presence events received so far, including peers without a location fix.
  Map<String, PeerPresence> get peerPresence =>
      Map.unmodifiable(_peerPresenceByUser);

  Stream<Map<String, PeerPresence>> get peerPresenceUpdates =>
      _peerPresenceUpdates.stream;

  Stream<RealtimeSyncReason> get syncRequests => _syncRequests.stream;

  RelayHealth get health => _health;
  Stream<RelayHealth> get healthUpdates => _healthUpdates.stream;

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
    // Last-known people must become available before any crypto or network
    // initialization can stall. LivePresence receives these as neutral,
    // age-labelled cached fixes and the authoritative sync reconciles later.
    await _loadFixCache(session.userId);
    final generationReady = Completer<void>();
    _identityGenerationReady = generationReady.future;
    final api = _ref.read(apiProvider);
    final crypto = _ref.read(cryptoServiceProvider);
    late final MlsInit initResult;
    try {
      initResult = await crypto.init(session.userId);
      _setStartupCryptoBlocked(false);
    } on Object {
      _setStartupCryptoBlocked(true);
      rethrow;
    }

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
      _setStartupCryptoBlocked(false);
    } on Object catch (e) {
      if (initResult != MlsInit.restored) _setStartupCryptoBlocked(true);
      if (kDebugMode) debugPrint('keypackage top-up failed: $e');
    } finally {
      // setShareTargets can race session startup. Never choose a formation
      // direction until our own generation lookup has finished, or a newly
      // registered lexicographically-smaller user can initiate the rival group
      // before learning that its identity is the newer one.
      generationReady.complete();
    }

    // Durable WS (survives disconnect; jittered reconnect).
    final wsUrl = _wsUrlFor(_ref.read(serverUrlProvider));
    final queue = RelayQueue(store: _SecureRelayStore(session.userId));
    final ws =
        _wsFactory?.call(wsUrl, queue) ?? WsService(wsUrl: wsUrl, queue: queue);
    _ws = ws;
    _syncDiffSub = _ref
        .read(realtimeSyncCoordinatorProvider)
        .diffs
        .listen((diff) => recordSyncResult(healthy: diff.healthy));
    _wsSub = ws.incoming.listen(_onIncoming);
    _wsHealthSub = ws.health.listen(_onWsHealth);
    _wsStateSub = ws.connectionStates.listen((state) {
      if (state == WsConnectionState.authenticated) {
        _requestSync(RealtimeSyncReason.wsAuthenticated);
      } else if (state == WsConnectionState.disconnected) {
        _clearPeerPresence();
      }
    });
    await ws.start(session.token);

    // Relay each local fix, encrypted per share.
    final location = _ref.read(locationServiceProvider);
    _onLocationHealth(location.currentHealth);
    _locationHealthSub = location.health.listen(_onLocationHealth);
    _fixSub = location.fixes.listen(_onLocalFix);
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
    final targets = userIds.toSet();
    _shareTargets
      ..clear()
      ..addAll(targets);
    _peerRekeyedAt
      ..clear()
      ..addAll(peerRekeyedAt);
    _shareSince
      ..clear()
      ..addAll(shareSince);
    final blockedBefore = _cryptoBlockedPeers.length;
    _cryptoBlockedPeers.removeWhere((peer) => !targets.contains(peer));
    if (_cryptoBlockedPeers.length != blockedBefore) {
      _emitHealth(status: _relayStatus);
    }
    for (final target in targets) {
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
    final payload = utf8.encode(jsonEncode(locationFixPayload(fix)));
    // Snapshot: setShareTargets can mutate the set across the encrypt await
    // (M3 — ConcurrentModificationError).
    for (final target in _shareTargets.toList()) {
      final gid = CryptoService.pairwiseGroupId(session.userId, target);
      if (!crypto.hasGroup(gid)) continue; // group forms at share-accept time
      late final Uint8List ct;
      try {
        ct = await crypto.encrypt(gid, Uint8List.fromList(payload));
        _setPeerCryptoBlocked(target, false);
      } on Object catch (e) {
        _setPeerCryptoBlocked(target, true);
        if (kDebugMode) debugPrint('relay encrypt for $target failed: $e');
        continue;
      }
      try {
        final frame = jsonEncode({
          'type': 'location.update',
          'recipient_type': 'user',
          'recipient_id': target,
          'blob': base64Encode(ct),
          'timestamp': fix.timestampMs,
        });
        await ws.send(target, frame);
      } on Object catch (e) {
        if (kDebugMode) debugPrint('relay queue/send for $target failed: $e');
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
      case 'profile.updated':
        final peer = msg['user_id'] as String?;
        if (peer != null) {
          unawaited(
            _ref
                .read(peopleControllerProvider.notifier)
                .profileUpdated(
                  peer,
                  profileVersion: msg['profile_version'] as int? ?? 0,
                  avatarChanged: msg['avatar_changed'] == true,
                ),
          );
          // Pending-request rows also carry names and avatars. The focused
          // People refresh above gives the primary surface same-turn polish;
          // the authoritative coordinator keeps every identity-bearing list
          // coherent without putting profile content in the WS frame.
          _requestSync(RealtimeSyncReason.relayEvent);
        }
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
          _setPeerCryptoBlocked(peer, false);
          _emitPeerPresence();
        }
        _requestSync(RealtimeSyncReason.relayEvent);
      case 'share.temp_created':
        // Someone started a temp share to me (or the server confirmed mine).
        _requestSync(RealtimeSyncReason.relayEvent);
      case 'share.temp_removed':
      case 'share.temp_expired':
      case 'share.temp_revoked':
        // Remove the exact relationship in the same turn as the teardown
        // frame. The final name is accepted for servers from the short-lived
        // pre-catalog implementation; current servers emit removed/expired.
        final id = msg['id'] as String?;
        final peer = msg['user_id'] as String?;
        if (id != null && peer != null) {
          final remaining = _ref
              .read(tempSharesControllerProvider.notifier)
              .removeLocally(id);
          final permanentPeers =
              _ref
                  .read(peopleControllerProvider)
                  .value
                  ?.map((person) => person.userId) ??
              const <String>[];
          if (!retainsPeerLocationAfterTempTeardown(
            remaining: remaining,
            me: _session?.userId,
            peer: peer,
            permanentPeers: permanentPeers,
            now: DateTime.now(),
          )) {
            _ref.read(livePresenceProvider.notifier).remove(peer);
            _peerPresenceByUser.remove(peer);
            _emitPeerPresence();
          }
        }
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

  void _removePeerPresence(String peer) {
    if (_peerPresenceByUser.remove(peer) != null) _emitPeerPresence();
  }

  void _requestSync(RealtimeSyncReason reason) {
    if (!_syncRequests.isClosed) _syncRequests.add(reason);
  }

  /// One command for the status affordance: retry transport while offline, or
  /// run the existing authoritative reconciliation path while connected.
  void retryOrSync() {
    final ws = _ws;
    if (ws == null) return;
    if (ws.isConnected) {
      unawaited(ws.flushNow());
      _requestSync(RealtimeSyncReason.manualRefresh);
    } else {
      unawaited(ws.retryNow());
    }
  }

  void _onWsHealth(WsHealth health) {
    final newlyAuthenticated =
        health.isAuthenticated &&
        _wsConnection != WsConnectionState.authenticated;
    _wsConnection = health.connection;
    if (newlyAuthenticated) {
      _hasAuthenticated = true;
      _syncHealthy = false;
    }
    _emitHealth(status: _relayStatus, queueDepth: health.queueDepth);
  }

  /// The coordinator owns the complete authoritative-sync boundary. A socket
  /// alone is never enough to claim Live.
  void recordSyncResult({required bool healthy, DateTime? completedAt}) {
    if (_session == null) return;
    _syncHealthy = healthy;
    if (healthy) _hasEverSynced = true;
    _emitHealth(
      status: _relayStatus,
      lastSyncAt: healthy ? completedAt ?? DateTime.now() : null,
    );
  }

  void _onLocationHealth(LocationHealth health) {
    _emitHealth(
      status: _relayStatus,
      locationBlocked: health.status == LocationHealthStatus.blocked,
    );
  }

  RelayHealthStatus get _relayStatus => switch (_wsConnection) {
    _ when _startupCryptoBlocked && !_hasAuthenticated =>
      RelayHealthStatus.cryptoBlocked,
    WsConnectionState.authenticated =>
      _hasCryptoBlock
          ? RelayHealthStatus.cryptoBlocked
          : _syncHealthy
          ? RelayHealthStatus.live
          : _hasEverSynced
          ? RelayHealthStatus.reconnecting
          : RelayHealthStatus.connecting,
    WsConnectionState.connecting =>
      _hasAuthenticated
          ? RelayHealthStatus.reconnecting
          : RelayHealthStatus.connecting,
    WsConnectionState.disconnected => RelayHealthStatus.offline,
  };

  bool get _hasCryptoBlock =>
      _startupCryptoBlocked ||
      _mailboxCryptoBlocked ||
      _cryptoBlockedPeers.isNotEmpty;

  void _setStartupCryptoBlocked(bool blocked) {
    if (_startupCryptoBlocked == blocked) return;
    _startupCryptoBlocked = blocked;
    _emitHealth(status: _relayStatus);
  }

  void _setMailboxCryptoBlocked(bool blocked) {
    if (_mailboxCryptoBlocked == blocked) return;
    _mailboxCryptoBlocked = blocked;
    _emitHealth(status: _relayStatus);
  }

  void _setPeerCryptoBlocked(String peer, bool blocked) {
    final changed = blocked
        ? _cryptoBlockedPeers.add(peer)
        : _cryptoBlockedPeers.remove(peer);
    if (!changed) return;
    _emitHealth(status: _relayStatus);
  }

  void _emitHealth({
    required RelayHealthStatus status,
    int? queueDepth,
    bool? locationBlocked,
    DateTime? lastSyncAt,
  }) {
    final next = RelayHealth(
      status: status,
      queueDepth: queueDepth ?? _health.queueDepth,
      locationBlocked: locationBlocked ?? _health.locationBlocked,
      lastSyncAt: lastSyncAt ?? _health.lastSyncAt,
    );
    _health = next;
    if (!_healthUpdates.isClosed) _healthUpdates.add(next);
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
      _setPeerCryptoBlocked(sender, false);
    } on Object catch (e) {
      _setPeerCryptoBlocked(sender, true);
      if (kDebugMode) debugPrint('peer fix decrypt failed: $e');
    }
  }

  /// Drain the authoritative MLS mailbox oldest-first. Durable crypto state and
  /// the local applied-id marker are committed atomically by [CryptoService]
  /// before the server row is ACKed. A poison row blocks only its own group;
  /// after three failed sync passes it is quarantined server-side so later
  /// commits can make progress without falsely marking the poison as applied.
  Future<MailboxDrainDiff> processMailbox() async {
    final diff = await _queueSessionWork(_processMailbox);
    if (diff.errors.contains(RealtimeSyncFailure.mailboxApplyFailed)) {
      _setMailboxCryptoBlocked(true);
    } else if (!diff.errors.contains(RealtimeSyncFailure.mailboxUnavailable) &&
        !diff.errors.contains(RealtimeSyncFailure.sessionChanged)) {
      _setMailboxCryptoBlocked(false);
    }
    return diff;
  }

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
              await _quarantine(session.token, id, reason: 'crypto_rejected')) {
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
    final authorizedPeers = peerUserIds.toSet();
    final peopleRevision = _ref
        .read(peopleControllerProvider.notifier)
        .authorizationRevision;
    if (peopleRevision > _lastPeopleAuthorizationRevision) {
      _lastPeopleAuthorizationRevision = peopleRevision;
      final permanentPeers =
          _ref
              .read(peopleControllerProvider)
              .value
              ?.map((person) => person.userId)
              .toSet() ??
          const <String>{};
      await _retainAuthorizedPeerFixes(
        authorizedPeers,
        permanentPeers,
        session.userId,
      );
    }
    for (final peerUserId in authorizedPeers) {
      try {
        final current = await api.currentFixes(session.token, peerUserId);
        if (!isSessionCurrent(epoch, session.userId)) {
          return const CurrentFixSyncDiff(
            errors: [RealtimeSyncFailure.sessionChanged],
          );
        }
        var accepted = await _decryptSnapshotRows(
          peerUserId,
          current,
          crypto: crypto,
          session: session,
        );

        // Current rows are durable last-known snapshots. History remains a
        // compatibility fallback for older servers and repairs a missing or
        // undecryptable current row without discarding an existing cache.
        if (!accepted) {
          final history = await api.locationHistory(
            session.token,
            peerUserId,
            since: _latestFixTimestamp[peerUserId] ?? 0,
          );
          if (!isSessionCurrent(epoch, session.userId)) {
            return const CurrentFixSyncDiff(
              errors: [RealtimeSyncFailure.sessionChanged],
            );
          }
          accepted = await _decryptSnapshotRows(
            peerUserId,
            history,
            crypto: crypto,
            session: session,
          );
        }
        if (accepted) updated.add(peerUserId);
      } on Object catch (e) {
        errors.add(RealtimeSyncFailure.currentFixFailed);
        if (kDebugMode) {
          debugPrint('current fix reconcile for $peerUserId failed: $e');
        }
      }
    }
    return CurrentFixSyncDiff(updatedPeers: updated, errors: errors);
  }

  Future<bool> _decryptSnapshotRows(
    String peerUserId,
    Iterable<EncryptedCurrentFix> rows, {
    required CryptoService crypto,
    required Session session,
  }) async {
    var accepted = false;
    final newestFirst = rows.toList()
      ..sort((a, b) => b.clientTimestamp.compareTo(a.clientTimestamp));
    for (final row in newestFirst) {
      if (row.clientTimestamp <= (_latestFixTimestamp[peerUserId] ?? 0)) {
        continue;
      }
      final groupId = row.recipientType == 'group'
          ? CryptoService.groupIdFor(row.recipientId)
          : CryptoService.pairwiseGroupId(session.userId, peerUserId);
      if (!crypto.hasGroup(groupId)) continue;
      final plaintext = await crypto.decrypt(groupId, base64Decode(row.blob));
      final data = jsonDecode(utf8.decode(plaintext)) as Map<String, dynamic>;
      if (await _acceptPeerFix(
        peerUserId,
        data,
        expectedTimestamp: row.clientTimestamp,
      )) {
        accepted = true;
      }
    }
    return accepted;
  }

  Future<bool> _acceptPeerFix(
    String userId,
    Map<String, dynamic> data, {
    int? expectedTimestamp,
  }) async {
    if (!_isValidPeerFix(data)) return false;
    final timestamp = (data['timestamp'] as num).toInt();
    if (expectedTimestamp != null && timestamp != expectedTimestamp) {
      return false;
    }
    if (timestamp <= (_latestFixTimestamp[userId] ?? 0)) return false;
    final fix = PeerFix(
      userId: userId,
      data: Map<String, dynamic>.from(data),
      receivedAt: DateTime.now(),
    );
    _latestFixTimestamp[userId] = timestamp;
    _cachedPeerFixes[userId] = fix;
    final permanent = _ref
        .read(peopleControllerProvider)
        .value
        ?.any((person) => person.userId == userId);
    if (permanent ?? false) _permanentCachedPeers.add(userId);
    _peerFixes.add(fix);
    final session = _session;
    if (session != null) await _writeFixCache(session.userId);
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

  static const _maxCachedPeers = 64;

  String _fixCacheKey(String userId) => 'point.relay.fix-cache.$userId';

  Future<void> _loadFixCache(String userId) async {
    _latestFixTimestamp.clear();
    _cachedPeerFixes.clear();
    _permanentCachedPeers.clear();
    _clearPeerPresence();
    try {
      final raw = await _storage.read(key: _fixCacheKey(userId));
      if (raw == null) return;
      final root = jsonDecode(raw) as Map<String, dynamic>;
      final entries = root['fixes'] as Map<String, dynamic>?;
      if (root['version'] != 1 || entries == null) return;
      final decoded = <PeerFix>[];
      for (final entry in entries.entries) {
        final encoded = entry.value;
        if (encoded is! Map<String, dynamic>) continue;
        final data = encoded['data'];
        if (data is! Map<String, dynamic> || !_isValidPeerFix(data)) continue;
        final receivedAt = DateTime.tryParse(
          encoded['received_at'] as String? ?? '',
        );
        final fix = PeerFix(
          userId: entry.key,
          data: Map<String, dynamic>.from(data),
          receivedAt: receivedAt,
        );
        decoded.add(fix);
      }
      decoded.sort((a, b) => (b.timestamp ?? 0).compareTo(a.timestamp ?? 0));
      for (final fix in decoded.take(_maxCachedPeers)) {
        _cachedPeerFixes[fix.userId] = fix;
        _latestFixTimestamp[fix.userId] = fix.timestamp!;
        final encoded = entries[fix.userId];
        if (encoded is Map<String, dynamic> &&
            encoded['access'] == 'permanent') {
          _permanentCachedPeers.add(fix.userId);
        }
      }
      // Broadcast for an already-mounted provider; a provider mounted later
      // reads [cachedPeerFixes] synchronously instead.
      _cachedPeerFixes.values.forEach(_peerFixes.add);
    } on Object catch (e) {
      _latestFixTimestamp.clear();
      _cachedPeerFixes.clear();
      _permanentCachedPeers.clear();
      if (kDebugMode) debugPrint('load peer-fix cache failed: $e');
    }
  }

  Future<void> _writeFixCache(String userId) async {
    final entries = _cachedPeerFixes.entries.toList()
      ..sort(
        (a, b) => (b.value.timestamp ?? 0).compareTo(a.value.timestamp ?? 0),
      );
    final value = jsonEncode({
      'version': 1,
      'fixes': {
        for (final entry in entries.take(_maxCachedPeers))
          entry.key: {
            'data': entry.value.data,
            'received_at': entry.value.receivedAt?.toUtc().toIso8601String(),
            'access': _permanentCachedPeers.contains(entry.key)
                ? 'permanent'
                : 'temporary',
          },
      },
    });
    _fixCacheWriteTail = _fixCacheWriteTail.catchError((Object _) {}).then((
      _,
    ) async {
      try {
        await _storage.write(key: _fixCacheKey(userId), value: value);
      } on Object catch (e) {
        if (kDebugMode) debugPrint('persist peer-fix cache failed: $e');
      }
    });
    await _fixCacheWriteTail;
  }

  Future<void> removePeerFix(String userId) async {
    final removed = _cachedPeerFixes.remove(userId) != null;
    _latestFixTimestamp.remove(userId);
    _permanentCachedPeers.remove(userId);
    if (!removed) return;
    final session = _session;
    if (session != null) await _writeFixCache(session.userId);
  }

  Future<void> _retainAuthorizedPeerFixes(
    Set<String> authorizedPeers,
    Set<String> permanentPeers,
    String userId,
  ) async {
    final previousPermanentPeers = Set<String>.of(_permanentCachedPeers);
    _permanentCachedPeers.addAll(
      _cachedPeerFixes.keys.where(permanentPeers.contains),
    );
    final removed = _permanentCachedPeers
        .where((peer) => !authorizedPeers.contains(peer))
        .toList();
    _permanentCachedPeers.removeWhere((peer) => !permanentPeers.contains(peer));
    final classificationChanged = !setEquals(
      previousPermanentPeers,
      _permanentCachedPeers,
    );
    if (removed.isEmpty && !classificationChanged) return;
    for (final peer in removed) {
      _cachedPeerFixes.remove(peer);
      _latestFixTimestamp.remove(peer);
    }
    removed.forEach(_ref.read(livePresenceProvider.notifier).remove);
    await _writeFixCache(userId);
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
    await _fixCacheWriteTail.catchError((Object _) {});
    await _fixSub?.cancel();
    _fixSub = null;
    await _wsSub?.cancel();
    _wsSub = null;
    await _wsStateSub?.cancel();
    _wsStateSub = null;
    await _wsHealthSub?.cancel();
    _wsHealthSub = null;
    await _locationHealthSub?.cancel();
    _locationHealthSub = null;
    await _syncDiffSub?.cancel();
    _syncDiffSub = null;
    await _ws?.dispose();
    _ws = null;
    _session = null;
    _shareTargets.clear();
    _peerRekeyedAt.clear();
    _shareSince.clear();
    _selfRekeyedAt = null;
    _identityGenerationReady = null;
    _generationRetryScheduled = false;
    _lastPeopleAuthorizationRevision = 0;
    _latestFixTimestamp.clear();
    _cachedPeerFixes.clear();
    _permanentCachedPeers.clear();
    _wsConnection = WsConnectionState.disconnected;
    _hasAuthenticated = false;
    _syncHealthy = false;
    _hasEverSynced = false;
    _startupCryptoBlocked = false;
    _mailboxCryptoBlocked = false;
    _cryptoBlockedPeers.clear();
    _health = const RelayHealth.offline();
    if (!_healthUpdates.isClosed) _healthUpdates.add(_health);
    _clearPeerPresence();
  }

  Future<void> dispose() async {
    await stop();
    await _peerFixes.close();
    await _peerPresenceUpdates.close();
    await _syncRequests.close();
    await _healthUpdates.close();
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

Map<String, T> withoutPeerFix<T>(Map<String, T> fixes, String userId) =>
    {...fixes}..remove(userId);

const _formationMarkerPrefix = 'point.mls.pair-formation.';

typedef _HandledFormation = ({DateTime? peerRekeyedAt, DateTime? shareSince});

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

/// Presentation-facing relay truth. Map and People can watch this without
/// depending on the mutable service, and the action uses the same provider.
class RelayHealthNotifier extends Notifier<RelayHealth> {
  @override
  RelayHealth build() {
    final relay = ref.read(relayControllerProvider);
    final healthSub = relay.healthUpdates.listen((health) => state = health);
    ref.onDispose(() {
      unawaited(healthSub.cancel());
    });
    return relay.health;
  }

  void retryOrSync() => ref.read(relayControllerProvider).retryOrSync();
}

final relayHealthProvider = NotifierProvider<RelayHealthNotifier, RelayHealth>(
  RelayHealthNotifier.new,
);

@immutable
class RelayHealthPresentation {
  const RelayHealthPresentation({
    required this.title,
    required this.detail,
    required this.icon,
    required this.actionLabel,
  });

  factory RelayHealthPresentation.from(RelayHealth health, {DateTime? now}) {
    if (health.locationBlocked && health.status == RelayHealthStatus.live) {
      return const RelayHealthPresentation(
        title: 'Location unavailable',
        detail: 'Last-known locations stay visible',
        icon: Icons.location_off_outlined,
        actionLabel: null,
      );
    }
    if (health.queueDepth > 0 && health.status == RelayHealthStatus.live) {
      final updates = health.queueDepth == 1 ? 'update' : 'updates';
      return RelayHealthPresentation(
        title: 'Syncing ${health.queueDepth} $updates',
        detail: 'Locations stay cached until sent',
        icon: Icons.sync_outlined,
        actionLabel: 'Sync',
      );
    }
    return switch (health.status) {
      RelayHealthStatus.connecting => const RelayHealthPresentation(
        title: 'Connecting',
        detail: 'Last-known locations stay visible',
        icon: Icons.more_horiz,
        actionLabel: null,
      ),
      RelayHealthStatus.live => RelayHealthPresentation(
        title: 'Live',
        detail: _lastSyncLabel(health.lastSyncAt, now: now),
        icon: Icons.check_circle,
        actionLabel: 'Sync',
      ),
      RelayHealthStatus.reconnecting => const RelayHealthPresentation(
        title: 'Reconnecting',
        detail: 'Showing last-known locations',
        icon: Icons.sync_outlined,
        actionLabel: 'Retry',
      ),
      RelayHealthStatus.offline => const RelayHealthPresentation(
        title: 'Offline',
        detail: 'Showing last-known locations',
        icon: Icons.cloud_off_outlined,
        actionLabel: 'Retry',
      ),
      RelayHealthStatus.cryptoBlocked => const RelayHealthPresentation(
        title: 'Secure sync blocked',
        detail: 'Some location updates could not be opened',
        icon: Icons.lock_outline,
        actionLabel: 'Retry',
      ),
    };
  }

  final String title;
  final String detail;
  final IconData icon;
  final String? actionLabel;

  static String _lastSyncLabel(DateTime? lastSyncAt, {DateTime? now}) {
    if (lastSyncAt == null) return 'Checking for updates';
    final elapsed = (now ?? DateTime.now()).difference(lastSyncAt);
    if (elapsed.inMinutes < 1) return 'Synced just now';
    if (elapsed.inHours < 1) return 'Synced ${elapsed.inMinutes}m ago';
    return 'Synced ${elapsed.inHours}h ago';
  }
}

/// Shared, monochrome status surface for Map and People. Text and icon shape
/// carry every state, and state changes become instant when motion is reduced.
class RelayHealthBanner extends ConsumerWidget {
  const RelayHealthBanner({
    super.key,
    this.health,
    this.onAction,
    this.showAction = true,
  });

  final RelayHealth? health;
  final VoidCallback? onAction;
  final bool showAction;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final RelayHealth current;
    if (health case final supplied?) {
      current = supplied;
    } else {
      current = ref.watch(relayHealthProvider);
    }
    final presentation = RelayHealthPresentation.from(current);
    final motion = ref.watch(settingsProvider.select((value) => value.motion));
    final reducedMotion =
        motion == MotionPreference.reduced ||
        (motion == MotionPreference.system &&
            MediaQuery.disableAnimationsOf(context));
    final action = showAction ? presentation.actionLabel : null;
    return Semantics(
      container: true,
      liveRegion: true,
      label: '${presentation.title}. ${presentation.detail}',
      child: AnimatedSwitcher(
        duration: reducedMotion
            ? Duration.zero
            : const Duration(milliseconds: 180),
        switchInCurve: Curves.easeOutQuart,
        switchOutCurve: Curves.easeOutQuart,
        child: ColoredBox(
          key: ValueKey((
            current.status,
            current.queueDepth,
            current.locationBlocked,
          )),
          color: context.colors.surfaceContainer,
          child: Padding(
            padding: EdgeInsets.symmetric(
              horizontal: context.space.md,
              vertical: context.space.xs,
            ),
            child: Row(
              children: [
                Icon(
                  presentation.icon,
                  size: 20,
                  color: context.colors.onSurfaceVariant,
                ),
                SizedBox(width: context.space.sm),
                Expanded(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(presentation.title, style: context.text.labelLarge),
                      Text(
                        presentation.detail,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: context.text.bodySmall?.copyWith(
                          color: context.colors.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
                if (action != null)
                  TextButton(
                    onPressed:
                        onAction ??
                        () => ref
                            .read(relayHealthProvider.notifier)
                            .retryOrSync(),
                    child: Text(action),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Latest decrypted position per peer, fed by the relay's `peerFixes` (H2 — the
/// receive path now terminates somewhere the map watches, not a dead stream).
/// Keyed by peer user id.
class LivePresence extends Notifier<Map<String, PeerMarkerMotion>> {
  @override
  Map<String, PeerMarkerMotion> build() {
    final relay = _ref();
    final sub = relay.peerFixes.listen((fix) {
      final current = state[fix.userId];
      state = {
        ...state,
        fix.userId: current == null
            ? PeerMarkerMotion.initial(fix)
            : current.advance(fix),
      };
    });
    ref
      ..onDispose(sub.cancel)
      ..listen(incomingTempsProvider, (previous, next) {
        final permanentPeers =
            ref
                .read(peopleControllerProvider)
                .value
                ?.map((person) => person.userId) ??
            const <String>[];
        final removed = peersLosingTempLocationAccess(
          previous: previous,
          next: next,
          permanentPeers: permanentPeers,
        );
        if (removed.isEmpty) return;
        state = {
          for (final entry in state.entries)
            if (!removed.contains(entry.key)) entry.key: entry.value,
        };
        for (final peer in removed) {
          relay._removePeerPresence(peer);
          unawaited(relay.removePeerFix(peer));
        }
      });
    return {
      for (final entry in relay.cachedPeerFixes.entries)
        entry.key: PeerMarkerMotion.initial(entry.value),
    };
  }

  RelayController _ref() => ref.read(relayControllerProvider);

  void remove(String userId) {
    if (!state.containsKey(userId)) return;
    state = withoutPeerFix(state, userId);
    unawaited(_ref().removePeerFix(userId));
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
