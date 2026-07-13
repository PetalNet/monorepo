import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/crypto/crypto_service.dart';
import 'package:point_app/features/people/people_presence.dart';
import 'package:point_app/features/people/requests_controller.dart';
import 'package:point_app/features/relay/data/realtime_sync_coordinator.dart';
import 'package:point_app/features/relay/domain/realtime_sync_models.dart';
import 'package:point_app/features/relay/reconnect_policy.dart';
import 'package:point_app/features/relay/relay_controller.dart';
import 'package:point_app/features/relay/relay_queue.dart';
import 'package:point_app/features/relay/ws_service.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/api/point_api.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/src/rust/frb_generated.dart';
import 'package:point_app/theme/presence_tokens.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

const _janet = Session(
  token: 'janet-token',
  userId: 'janet@point.test',
  displayName: 'Janet',
  isAdmin: false,
);
const _parkerId = 'parker@point.test';

class _Auth extends AuthController {
  @override
  Future<Session?> build() async => _janet;

  void replace(Session? session) => state = AsyncData(session);
}

class _FakeApi implements PointApi {
  final mailbox = <Map<String, dynamic>>[];
  final incoming = <ShareRequest>[];
  final outgoing = <OutgoingShareRequest>[];
  final temps = <TempShare>[];
  final shares = <Map<String, dynamic>>[];
  final current = <String, List<EncryptedCurrentFix>>{};
  final acked = <String>[];
  final quarantined = <String>[];
  final uploadedKeyPackages = <String>[];
  Duration mailboxDelay = Duration.zero;
  int activeMailboxReads = 0;
  int maxConcurrentMailboxReads = 0;
  int failMailboxReads = 0;
  int failAcks = 0;
  Completer<void>? mailboxGate;

  @override
  Future<List<Map<String, dynamic>>> mlsMessages(String token) async {
    activeMailboxReads++;
    if (activeMailboxReads > maxConcurrentMailboxReads) {
      maxConcurrentMailboxReads = activeMailboxReads;
    }
    await Future<void>.delayed(mailboxDelay);
    await mailboxGate?.future;
    activeMailboxReads--;
    if (failMailboxReads > 0) {
      failMailboxReads--;
      throw StateError('mailbox temporarily unavailable');
    }
    return mailbox.map(Map<String, dynamic>.from).toList();
  }

  @override
  Future<void> ackMlsMessage(String token, String id) async {
    if (failAcks > 0) {
      failAcks--;
      throw StateError('ACK temporarily unavailable');
    }
    acked.add(id);
    mailbox.removeWhere((message) => message['id'] == id);
  }

  @override
  Future<void> quarantineMlsMessage(
    String token,
    String id, {
    required String reason,
  }) async {
    quarantined.add(id);
    mailbox.removeWhere((message) => message['id'] == id);
  }

  @override
  Future<void> uploadKeyPackages(
    String token,
    List<String> keyPackages, {
    String? lastResort,
    bool replace = false,
  }) async {
    if (replace) uploadedKeyPackages.clear();
    uploadedKeyPackages.addAll(keyPackages);
  }

  @override
  Future<({int available, bool hasLastResort, DateTime rekeyedAt})> keyCount(
    String token,
  ) async => (
    available: uploadedKeyPackages.length,
    hasLastResort: false,
    rekeyedAt: DateTime.utc(2026, 7, 13),
  );

  @override
  Future<List<Map<String, dynamic>>> activeShares(String token) async =>
      shares.map(Map<String, dynamic>.from).toList();

  @override
  Future<List<ShareRequest>> incomingRequests(String token) async =>
      List.of(incoming);

  @override
  Future<List<OutgoingShareRequest>> outgoingRequests(String token) async =>
      List.of(outgoing);

  @override
  Future<List<TempShare>> listTempShares(String token) async => List.of(temps);

  @override
  Future<GhostState> getGhost(String token) async =>
      const GhostState(active: false);

  @override
  Future<MeProfile> getMe(String token) async => const MeProfile(
    userId: 'janet@point.test',
    displayName: 'Janet',
    whoCanAddMe: 'anyone',
    hasAvatar: false,
    ghostActive: false,
  );

  @override
  Future<List<EncryptedCurrentFix>> currentFixes(
    String token,
    String userId,
  ) async => List.of(current[userId] ?? const []);

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('${invocation.memberName}');
}

class _NoopCrypto extends CryptoService {
  @override
  Future<MlsInit> init(String identity) async => MlsInit.restored;

  @override
  Future<Uint8List> generateKeyPackage() async => Uint8List.fromList([1]);

  @override
  bool hasGroup(Uint8List groupId) => false;
}

class _MailboxCrypto extends _NoopCrypto {
  final applied = <String>[];

  @override
  Future<MailboxApplyResult> processMailboxWelcome(
    String messageId,
    Uint8List welcome,
  ) async {
    applied.add(messageId);
    return MailboxApplyResult.applied;
  }
}

class _SnapshotCrypto extends _NoopCrypto {
  @override
  bool hasGroup(Uint8List groupId) => true;

  @override
  Future<Uint8List> decrypt(Uint8List groupId, Uint8List ciphertext) async =>
      Uint8List.fromList(
        utf8.encode(
          jsonEncode({
            'lat': 41.9,
            'lon': -87.6,
            'speed': 0.0,
            'timestamp': 3000,
          }),
        ),
      );
}

class _RejectingMailboxCrypto extends _NoopCrypto {
  @override
  Future<MailboxApplyResult> processMailboxWelcome(
    String messageId,
    Uint8List welcome,
  ) => throw StateError('crypto rejected row');
}

class _WsHarness {
  final channels = <_FakeChannel>[];

  WsService create(String wsUrl, RelayQueue queue) => WsService(
    wsUrl: wsUrl,
    queue: queue,
    policy: ReconnectPolicy(base: Duration.zero, jitter: 0),
    connect: (_) {
      final channel = _FakeChannel();
      channels.add(channel);
      return channel;
    },
  );
}

class _FakeChannel implements WebSocketChannel {
  _FakeChannel() {
    _sink.onAdd = (value) => sent.add(value as String);
  }

  final _incoming = StreamController<dynamic>.broadcast();
  final sent = <String>[];
  final _sink = _FakeSink();

  void push(Map<String, dynamic> message) => _incoming.add(jsonEncode(message));

  Future<void> closeFromServer() => _incoming.close();

  @override
  Stream<dynamic> get stream => _incoming.stream;

  @override
  WebSocketSink get sink => _sink;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeSink implements WebSocketSink {
  void Function(dynamic)? onAdd;

  @override
  void add(dynamic data) => onAdd?.call(data);

  @override
  Future<void> close([int? closeCode, String? closeReason]) async {}

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Future<void> _waitFor(bool Function() condition) async {
  for (var i = 0; i < 100 && !condition(); i++) {
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
  expect(condition(), isTrue);
}

ProviderContainer _container({
  required _FakeApi api,
  required CryptoService crypto,
  required _WsHarness sockets,
}) => ProviderContainer(
  overrides: [
    authControllerProvider.overrideWith(_Auth.new),
    apiProvider.overrideWithValue(api),
    cryptoServiceProvider.overrideWithValue(crypto),
    relayControllerProvider.overrideWith(
      (ref) => RelayController(ref, wsFactory: sockets.create),
    ),
  ],
);

void main() {
  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    await RustLib.init();
  });

  test('presence.update is ordered and cleared on transport loss', () async {
    FlutterSecureStorage.setMockInitialValues({});
    final api = _FakeApi();
    final sockets = _WsHarness();
    final container = _container(
      api: api,
      crypto: _NoopCrypto(),
      sockets: sockets,
    );
    addTearDown(container.dispose);
    await container.read(authControllerProvider.future);
    final relay = container.read(relayControllerProvider);
    await relay.start(_janet);
    container.listen(peerPresenceProvider, (_, _) {});

    sockets.channels.single.push({'type': 'auth.ok'});
    sockets.channels.single.push({
      'type': 'presence.update',
      'user_id': _parkerId,
      'online': true,
      'observed_at': 2000,
      'battery': 61,
      'activity': 'walking',
    });
    await _waitFor(
      () => container.read(peerPresenceProvider)[_parkerId]?.online ?? false,
    );
    final online = container.read(peerPresenceProvider)[_parkerId]!;
    expect(online.battery, 61);
    expect(online.activity, 'walking');

    // A delayed frame from before the online transition cannot resurrect an
    // older state after a snapshot/live-event race.
    sockets.channels.single.push({
      'type': 'presence.update',
      'user_id': _parkerId,
      'online': false,
      'observed_at': 1000,
    });
    await Future<void>.delayed(Duration.zero);
    expect(container.read(peerPresenceProvider)[_parkerId]?.online, isTrue);

    sockets.channels.single.push({
      'type': 'presence.update',
      'user_id': _parkerId,
      'online': false,
      'observed_at': 3000,
    });
    await _waitFor(
      () => container.read(peerPresenceProvider)[_parkerId]?.online == false,
    );

    const person = Person(
      userId: _parkerId,
      displayName: 'Parker',
      presence: PresenceState.away,
    );
    final merged = mergePresence(
      person,
      PeerFix(
        userId: _parkerId,
        data: {
          'lat': 41.88,
          'lon': -87.63,
          'timestamp': DateTime.now().millisecondsSinceEpoch,
        },
      ),
      serverPresence: container.read(peerPresenceProvider)[_parkerId],
    );
    expect(merged.presence, PresenceState.stale);
    expect(merged.hasLocation, isTrue);

    await sockets.channels.single.closeFromServer();
    await _waitFor(() => container.read(peerPresenceProvider).isEmpty);
  });

  test(
    'missed MLS notice recovers on reconnect, ACKs Welcome and Commit, '
    'then decrypts live fixes without restart',
    () async {
      FlutterSecureStorage.setMockInitialValues({});
      final api = _FakeApi()
        ..shares.add({
          'user_id': _parkerId,
          'display_name': 'Parker',
          'rekeyed_at': DateTime.utc(2026, 7, 12).toIso8601String(),
          'since': DateTime.utc(2026, 7, 13).toIso8601String(),
        });
      final receiver = CryptoService();
      final sender = CryptoService();
      final sockets = _WsHarness();
      final container = _container(
        api: api,
        crypto: receiver,
        sockets: sockets,
      );
      addTearDown(container.dispose);
      await container.read(authControllerProvider.future);
      final coordinator = container.read(realtimeSyncCoordinatorProvider);
      final relay = container.read(relayControllerProvider);
      await relay.start(_janet);

      final initialSync = coordinator.diffs.firstWhere(
        (diff) => diff.reason == RealtimeSyncReason.wsAuthenticated,
      );
      sockets.channels.single.push({'type': 'auth.ok'});
      await initialSync;

      await sender.init(_parkerId);
      final groupId = CryptoService.pairwiseGroupId(_janet.userId, _parkerId);
      await sender.createGroup(groupId);
      final added = await sender.addMember(
        groupId,
        base64Decode(api.uploadedKeyPackages.first),
      );
      api.mailbox.add({
        'id': 'welcome-1',
        'message_type': 'welcome',
        'group_id': utf8.decode(groupId),
        'sender_id': _parkerId,
        'payload': base64Encode(added.welcome),
        'created_at': '2026-07-13T00:00:00Z',
      });
      api.failAcks = 1;

      // Deliberately drop the mls.message live notice, then reconnect. The
      // second auth is the only trigger that can discover this durable row.
      await sockets.channels.single.closeFromServer();
      await _waitFor(() => sockets.channels.length == 2);
      final reconnectSync = coordinator.diffs.firstWhere(
        (diff) => diff.reason == RealtimeSyncReason.wsAuthenticated,
      );
      final ackRetry = coordinator.diffs
          .firstWhere((diff) => diff.reason == RealtimeSyncReason.retry)
          .timeout(const Duration(seconds: 3));
      sockets.channels.last.push({'type': 'auth.ok'});
      final welcomeDiff = await reconnectSync;
      expect(welcomeDiff.mailbox.applied, 1);
      expect(
        welcomeDiff.mailbox.errors,
        contains(RealtimeSyncFailure.mailboxAckFailed),
      );
      final retriedWelcome = await ackRetry;
      expect(retriedWelcome.mailbox.alreadyApplied, 1);
      expect(api.acked, contains('welcome-1'));
      expect(receiver.hasGroup(groupId), isTrue);

      final firstFix = relay.peerFixes.first;
      final firstCiphertext = await sender.encrypt(
        groupId,
        Uint8List.fromList(
          utf8.encode(
            jsonEncode({
              'lat': 41.88,
              'lon': -87.63,
              'speed': 0.0,
              'timestamp': 1000,
            }),
          ),
        ),
      );
      sockets.channels.last.push({
        'type': 'location.broadcast',
        'sender_id': _parkerId,
        'blob': base64Encode(firstCiphertext),
        'timestamp': 1000,
      });
      expect((await firstFix).data['lat'], 41.88);

      final carol = CryptoService();
      await carol.init('carol@point.test');
      final commit = await sender.addMember(
        groupId,
        await carol.generateKeyPackage(),
      );
      api.mailbox.add({
        'id': 'commit-1',
        'message_type': 'commit',
        'group_id': utf8.decode(groupId),
        'sender_id': _parkerId,
        'payload': base64Encode(commit.commit),
        'created_at': '2026-07-13T00:00:01Z',
      });
      final commitDiff = await coordinator.syncNow(
        RealtimeSyncReason.manualRefresh,
      );
      expect(commitDiff.mailbox.applied, 1);
      expect(api.acked, contains('commit-1'));

      final secondFix = relay.peerFixes.first;
      final secondCiphertext = await sender.encrypt(
        groupId,
        Uint8List.fromList(
          utf8.encode(
            jsonEncode({
              'lat': 41.89,
              'lon': -87.62,
              'speed': 1.0,
              'timestamp': 2000,
            }),
          ),
        ),
      );
      sockets.channels.last.push({
        'type': 'location.broadcast',
        'sender_id': _parkerId,
        'blob': base64Encode(secondCiphertext),
        'timestamp': 2000,
      });
      expect((await secondFix).data['timestamp'], 2000);
    },
    timeout: const Timeout(Duration(minutes: 2)),
  );

  test('share.request updates an already-mounted requests provider', () async {
    FlutterSecureStorage.setMockInitialValues({});
    final api = _FakeApi();
    final sockets = _WsHarness();
    final container = _container(
      api: api,
      crypto: _NoopCrypto(),
      sockets: sockets,
    );
    addTearDown(container.dispose);
    await container.read(authControllerProvider.future);

    final mountedNotifier = container.read(requestsControllerProvider.notifier);
    await container.read(requestsControllerProvider.future);
    final coordinator = container.read(realtimeSyncCoordinatorProvider);
    await container.read(relayControllerProvider).start(_janet);
    final initialSync = coordinator.diffs.firstWhere(
      (diff) => diff.reason == RealtimeSyncReason.wsAuthenticated,
    );
    sockets.channels.single.push({'type': 'auth.ok'});
    await initialSync;

    api.incoming.add(
      const ShareRequest(
        id: 'request-1',
        fromUserId: _parkerId,
        fromDisplayName: 'Parker',
      ),
    );
    final requestSync = coordinator.diffs.firstWhere(
      (diff) => diff.reason == RealtimeSyncReason.shareRequest,
    );
    sockets.channels.single.push({'type': 'share.request'});
    final diff = await requestSync;

    expect(diff.incomingRequestsAdded, {'request-1'});
    expect(container.read(requestsControllerProvider).value, hasLength(1));
    expect(
      container.read(requestsControllerProvider.notifier),
      same(mountedNotifier),
      reason: 'the live row must surface without provider recreation',
    );
  });

  test('a poison row is quarantined and does not block the next row', () async {
    FlutterSecureStorage.setMockInitialValues({});
    final api = _FakeApi()
      ..mailbox.addAll([
        {
          'id': 'poison-1',
          'message_type': 'welcome',
          'group_id': 'dm:a:b',
          'sender_id': _parkerId,
          'payload': 'not base64',
          'created_at': '2026-07-13T00:00:00Z',
        },
        {
          'id': 'welcome-2',
          'message_type': 'welcome',
          'group_id': 'dm:a:b',
          'sender_id': _parkerId,
          'payload': base64Encode([1, 2, 3]),
          'created_at': '2026-07-13T00:00:01Z',
        },
      ]);
    final crypto = _MailboxCrypto();
    final sockets = _WsHarness();
    final container = _container(api: api, crypto: crypto, sockets: sockets);
    addTearDown(container.dispose);
    await container.read(authControllerProvider.future);
    container.read(realtimeSyncCoordinatorProvider);
    final relay = container.read(relayControllerProvider);
    await relay.start(_janet);

    final diff = await relay.processMailbox();
    expect(diff.quarantined, 1);
    expect(diff.quarantinedMessageIds, {'poison-1'});
    expect(diff.applied, 1);
    expect(api.quarantined, ['poison-1']);
    expect(api.acked, ['welcome-2']);
    expect(crypto.applied, ['welcome-2']);
  });

  test('crypto poison is quarantined after three bounded attempts', () async {
    FlutterSecureStorage.setMockInitialValues({});
    final api = _FakeApi()
      ..mailbox.add({
        'id': 'crypto-poison',
        'message_type': 'welcome',
        'group_id': 'dm:a:b',
        'sender_id': _parkerId,
        'payload': base64Encode([1, 2, 3]),
        'created_at': '2026-07-13T00:00:00Z',
      });
    final container = _container(
      api: api,
      crypto: _RejectingMailboxCrypto(),
      sockets: _WsHarness(),
    );
    addTearDown(container.dispose);
    await container.read(authControllerProvider.future);
    final relay = container.read(relayControllerProvider);
    await relay.start(_janet);

    final first = await relay.processMailbox();
    final second = await relay.processMailbox();
    final third = await relay.processMailbox();

    expect(first.errors, contains(RealtimeSyncFailure.mailboxApplyFailed));
    expect(second.errors, contains(RealtimeSyncFailure.mailboxApplyFailed));
    expect(third.quarantinedMessageIds, {'crypto-poison'});
    expect(api.quarantined, ['crypto-poison']);
  });

  test('current-fix catch-up includes incoming temporary sharers', () async {
    FlutterSecureStorage.setMockInitialValues({});
    final api = _FakeApi()
      ..temps.add(
        TempShare(
          id: 'temp-incoming',
          fromUserId: _parkerId,
          toUserId: _janet.userId,
          expiresAt: DateTime.now().add(const Duration(hours: 1)),
        ),
      )
      ..current[_parkerId] = const [
        EncryptedCurrentFix(
          blob: 'AA==',
          clientTimestamp: 3000,
          recipientType: 'user',
          recipientId: 'janet@point.test',
        ),
      ];
    final container = _container(
      api: api,
      crypto: _SnapshotCrypto(),
      sockets: _WsHarness(),
    );
    addTearDown(container.dispose);
    await container.read(authControllerProvider.future);
    final coordinator = container.read(realtimeSyncCoordinatorProvider);
    final relay = container.read(relayControllerProvider);
    await relay.start(_janet);
    final fix = relay.peerFixes.first;

    final diff = await coordinator.syncNow(RealtimeSyncReason.appResumed);

    expect(diff.currentFixes.updatedPeers, {_parkerId});
    expect((await fix).data['timestamp'], 3000);
  });

  test(
    'wake before relay startup retries after the relay becomes ready',
    () async {
      FlutterSecureStorage.setMockInitialValues({});
      final api = _FakeApi();
      final container = _container(
        api: api,
        crypto: _NoopCrypto(),
        sockets: _WsHarness(),
      );
      addTearDown(container.dispose);
      await container.read(authControllerProvider.future);
      final coordinator = container.read(realtimeSyncCoordinatorProvider);
      final retry = coordinator.diffs
          .firstWhere((diff) => diff.reason == RealtimeSyncReason.retry)
          .timeout(const Duration(seconds: 3));

      final wake = await coordinator.syncNow(RealtimeSyncReason.pushWake);
      expect(wake.errors, contains(RealtimeSyncFailure.sessionChanged));
      await container.read(relayControllerProvider).start(_janet);

      expect((await retry).healthy, isTrue);
    },
  );

  test('overlapping triggers are serialized', () async {
    FlutterSecureStorage.setMockInitialValues({});
    final api = _FakeApi()..mailboxDelay = const Duration(milliseconds: 30);
    final sockets = _WsHarness();
    final container = _container(
      api: api,
      crypto: _NoopCrypto(),
      sockets: sockets,
    );
    addTearDown(container.dispose);
    await container.read(authControllerProvider.future);
    final coordinator = container.read(realtimeSyncCoordinatorProvider);
    await container.read(relayControllerProvider).start(_janet);

    await Future.wait([
      coordinator.syncNow(RealtimeSyncReason.appResumed),
      coordinator.syncNow(RealtimeSyncReason.pushWake),
    ]);

    expect(api.maxConcurrentMailboxReads, 1);
  });

  test(
    'an unhealthy reconnect catch-up retries without another frame',
    () async {
      FlutterSecureStorage.setMockInitialValues({});
      final api = _FakeApi()..failMailboxReads = 1;
      final sockets = _WsHarness();
      final container = _container(
        api: api,
        crypto: _NoopCrypto(),
        sockets: sockets,
      );
      addTearDown(container.dispose);
      await container.read(authControllerProvider.future);
      final coordinator = container.read(realtimeSyncCoordinatorProvider);
      await container.read(relayControllerProvider).start(_janet);

      final retry = coordinator.diffs
          .firstWhere((diff) => diff.reason == RealtimeSyncReason.retry)
          .timeout(const Duration(seconds: 3));
      final first = await coordinator.syncNow(
        RealtimeSyncReason.wsAuthenticated,
      );
      expect(first.healthy, isFalse);
      expect((await retry).healthy, isTrue);
      expect(api.maxConcurrentMailboxReads, 1);
    },
  );

  test('teardown invalidates an in-flight old-session mailbox read', () async {
    FlutterSecureStorage.setMockInitialValues({});
    final gate = Completer<void>();
    final api = _FakeApi()
      ..mailboxGate = gate
      ..mailbox.add({
        'id': 'old-session-welcome',
        'message_type': 'welcome',
        'group_id': 'dm:janet:parker',
        'sender_id': _parkerId,
        'payload': base64Encode([1, 2, 3]),
        'created_at': '2026-07-13T00:00:00Z',
      });
    final crypto = _MailboxCrypto();
    final sockets = _WsHarness();
    final container = _container(api: api, crypto: crypto, sockets: sockets);
    addTearDown(container.dispose);
    await container.read(authControllerProvider.future);
    final coordinator = container.read(realtimeSyncCoordinatorProvider);
    final relay = container.read(relayControllerProvider);
    await relay.start(_janet);
    final epoch = relay.sessionEpoch;

    final sync = coordinator.syncNow(RealtimeSyncReason.appResumed);
    await _waitFor(() => api.activeMailboxReads == 1);
    (container.read(authControllerProvider.notifier) as _Auth).replace(null);
    final stopping = relay.stop();
    await _waitFor(() => relay.sessionEpoch != epoch);
    gate.complete();
    final diff = await sync;
    await stopping;

    expect(diff.errors, contains(RealtimeSyncFailure.sessionChanged));
    expect(crypto.applied, isEmpty);
    expect(api.acked, isEmpty);
  });
}
