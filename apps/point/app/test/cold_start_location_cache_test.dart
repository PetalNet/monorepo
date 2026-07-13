import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:point_app/features/crypto/crypto_service.dart';
import 'package:point_app/features/map/presentation/presence_marker.dart';
import 'package:point_app/features/people/people_controller.dart';
import 'package:point_app/features/people/people_presence.dart';
import 'package:point_app/features/relay/reconnect_policy.dart';
import 'package:point_app/features/relay/relay_controller.dart';
import 'package:point_app/features/relay/relay_queue.dart';
import 'package:point_app/features/relay/ws_service.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/api/point_api.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/theme/app_theme.dart';
import 'package:point_app/theme/presence_tokens.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

const _session = Session(
  token: 'janet-token',
  userId: 'janet@point.test',
  displayName: 'Janet',
  isAdmin: false,
);
const _peer = 'parker@point.test';

class _Auth extends AuthController {
  @override
  Future<Session?> build() async => _session;
}

class _FakeApi implements PointApi {
  List<EncryptedCurrentFix> current = const [];
  List<EncryptedCurrentFix> history = const [];
  List<Map<String, dynamic>> shares = const [];
  int historyReads = 0;
  int? lastHistorySince;

  @override
  Future<List<Map<String, dynamic>>> activeShares(String token) async =>
      List.of(shares);

  @override
  Future<({int available, bool hasLastResort, DateTime rekeyedAt})> keyCount(
    String token,
  ) async => (
    available: 5,
    hasLastResort: false,
    rekeyedAt: DateTime.utc(2026, 7, 13),
  );

  @override
  Future<List<EncryptedCurrentFix>> currentFixes(
    String token,
    String userId,
  ) async => List.of(current);

  @override
  Future<List<EncryptedCurrentFix>> locationHistory(
    String token,
    String userId, {
    int since = 0,
    int limit = 20,
  }) async {
    historyReads++;
    lastHistorySince = since;
    return List.of(history);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('${invocation.memberName}');
}

class _Crypto extends CryptoService {
  _Crypto(this.payload);

  final Map<String, dynamic> payload;

  @override
  Future<MlsInit> init(String identity) async => MlsInit.restored;

  @override
  bool hasGroup(Uint8List groupId) => true;

  @override
  Future<Uint8List> decrypt(Uint8List groupId, Uint8List ciphertext) async =>
      Uint8List.fromList(utf8.encode(jsonEncode(payload)));
}

class _GatedCrypto extends _Crypto {
  _GatedCrypto() : super(const {});

  final initGate = Completer<MlsInit>();

  @override
  Future<MlsInit> init(String identity) => initGate.future;
}

class _SocketHarness {
  WsService create(String wsUrl, RelayQueue queue) => WsService(
    wsUrl: wsUrl,
    queue: queue,
    policy: ReconnectPolicy(base: Duration.zero, jitter: 0),
    connect: (_) => _FakeChannel(),
  );
}

class _FakeChannel implements WebSocketChannel {
  final _incoming = StreamController<dynamic>.broadcast();
  final _sink = _FakeSink();

  @override
  Stream<dynamic> get stream => _incoming.stream;

  @override
  WebSocketSink get sink => _sink;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeSink implements WebSocketSink {
  @override
  void add(dynamic data) {}

  @override
  Future<void> close([int? closeCode, String? closeReason]) async {}

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

ProviderContainer _container(_FakeApi api, _Crypto crypto) => ProviderContainer(
  overrides: [
    authControllerProvider.overrideWith(_Auth.new),
    apiProvider.overrideWithValue(api),
    cryptoServiceProvider.overrideWithValue(crypto),
    relayControllerProvider.overrideWith(
      (ref) => RelayController(ref, wsFactory: _SocketHarness().create),
    ),
  ],
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('history client requests a bounded newest authorized window', () async {
    late Uri requested;
    final api = PointApi(
      baseUrl: 'https://point.test',
      client: MockClient((request) async {
        requested = request.url;
        return http.Response(
          jsonEncode([
            {
              'encrypted_blob': 'AA==',
              'client_timestamp': 4000,
              'recipient_type': 'user',
              'recipient_id': _session.userId,
            },
          ]),
          200,
        );
      }),
    );

    final rows = await api.locationHistory(
      _session.token,
      _peer,
      limit: 7,
    );

    expect(requested.path, '/api/history/parker%40point.test');
    expect(requested.queryParameters, {'since': '0', 'limit': '7'});
    expect(rows.single.clientTimestamp, 4000);
  });

  test(
    'persisted marker restores before crypto or network startup completes',
    () async {
      FlutterSecureStorage.setMockInitialValues({
        'point.relay.fix-cache.${_session.userId}': jsonEncode({
          'version': 1,
          'fixes': {
            _peer: {
              'data': {'lat': 41.9, 'lon': -87.6, 'timestamp': 5000},
              'received_at': '2026-07-13T12:00:00Z',
            },
          },
        }),
      });
      final crypto = _GatedCrypto();
      final container = _container(_FakeApi(), crypto);
      addTearDown(container.dispose);
      await container.read(authControllerProvider.future);
      final relay = container.read(relayControllerProvider);
      container.read(livePresenceProvider);

      final starting = relay.start(_session);
      for (var i = 0; i < 20; i++) {
        if (container.read(livePresenceProvider).containsKey(_peer)) break;
        await Future<void>.delayed(Duration.zero);
      }
      expect(container.read(livePresenceProvider), contains(_peer));
      expect(crypto.initGate.isCompleted, isFalse);

      crypto.initGate.complete(MlsInit.restored);
      await starting;
    },
  );

  test(
    'cold start restores cache, rejects older current, then accepts newer history',
    () async {
      FlutterSecureStorage.setMockInitialValues({
        'point.relay.fix-cache.${_session.userId}': jsonEncode({
          'version': 1,
          'fixes': {
            _peer: {
              'data': {'lat': 41.9, 'lon': -87.6, 'timestamp': 5000},
              'received_at': '2026-07-13T12:00:00Z',
            },
          },
        }),
      });
      final api = _FakeApi()
        ..current = const [
          EncryptedCurrentFix(
            blob: 'AA==',
            clientTimestamp: 4000,
            recipientType: 'user',
            recipientId: 'janet@point.test',
          ),
        ]
        ..history = const [
          EncryptedCurrentFix(
            blob: 'AA==',
            clientTimestamp: 6000,
            recipientType: 'user',
            recipientId: 'janet@point.test',
          ),
        ];
      final container = _container(
        api,
        _Crypto({'lat': 41.91, 'lon': -87.61, 'timestamp': 6000}),
      );
      addTearDown(container.dispose);
      await container.read(authControllerProvider.future);
      final relay = container.read(relayControllerProvider);

      await relay.start(_session);
      final restored = container.read(livePresenceProvider)[_peer]!.target;
      final diff = await relay.reconcileCurrentFixes([_peer]);

      expect(restored.timestamp, 5000);
      expect(restored.lat, 41.9);
      expect(diff.updatedPeers, {_peer});
      expect(
        container.read(livePresenceProvider)[_peer]!.target.timestamp,
        6000,
      );
      expect(api.historyReads, 1);
      expect(api.lastHistorySince, 5000);
    },
  );

  test(
    'expired current row falls back to history and seeds live state',
    () async {
      FlutterSecureStorage.setMockInitialValues({});
      final api = _FakeApi()
        ..history = const [
          EncryptedCurrentFix(
            blob: 'AA==',
            clientTimestamp: 3000,
            recipientType: 'user',
            recipientId: 'janet@point.test',
          ),
        ];
      final container = _container(
        api,
        _Crypto({'lat': 41.88, 'lon': -87.63, 'timestamp': 3000}),
      );
      addTearDown(container.dispose);
      await container.read(authControllerProvider.future);
      final relay = container.read(relayControllerProvider);
      await relay.start(_session);

      final diff = await relay.reconcileCurrentFixes([_peer]);
      final restored = container.read(livePresenceProvider)[_peer]!.target;

      expect(api.historyReads, 1);
      expect(diff.updatedPeers, {_peer});
      expect(restored.lat, 41.88);
      expect(restored.timestamp, 3000);
      expect(
        container.read(livePresenceProvider)[_peer]!.glideDuration,
        Duration.zero,
        reason: 'cold-start restoration must honor reduced motion by snapping',
      );
    },
  );

  testWidgets(
    'fresh open reconciles an aged current fix into a dark marker at last-known',
    (tester) async {
      final now = DateTime(2026, 7, 13, 12);
      final timestamp = now
          .subtract(const Duration(minutes: 16))
          .millisecondsSinceEpoch;
      FlutterSecureStorage.setMockInitialValues({});
      final api = _FakeApi()
        ..current = [
          EncryptedCurrentFix(
            blob: 'AA==',
            clientTimestamp: timestamp,
            recipientType: 'user',
            recipientId: _session.userId,
          ),
        ];
      final container = _container(
        api,
        _Crypto({
          'lat': 41.88,
          'lon': -87.63,
          'accuracy': 18,
          'timestamp': timestamp,
        }),
      );
      await container.read(authControllerProvider.future);
      final relay = container.read(relayControllerProvider);
      await relay.start(_session);

      final diff = await relay.reconcileCurrentFixes([_peer]);
      final fix = container.read(livePresenceProvider)[_peer]!.target;
      final person = mergePresence(
        const Person(
          userId: _peer,
          displayName: 'Parker',
          presence: PresenceState.away,
        ),
        fix,
        now: now,
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark(pureBlack: true),
          home: Scaffold(body: PresenceMarker(person: person)),
        ),
      );

      expect(diff.updatedPeers, {_peer});
      expect(api.historyReads, 0, reason: 'durable current is authoritative');
      expect(person.lat, 41.88);
      expect(person.lon, -87.63);
      expect(find.byKey(const ValueKey(PresenceState.stale)), findsOneWidget);
      expect(find.textContaining('Parker · dark since '), findsOneWidget);
      await tester.pumpWidget(const SizedBox.shrink());
      container.dispose();
      await tester.pump();
    },
  );

  test('REST envelope and encrypted payload timestamps must agree', () async {
    FlutterSecureStorage.setMockInitialValues({});
    final api = _FakeApi()
      ..current = const [
        EncryptedCurrentFix(
          blob: 'AA==',
          clientTimestamp: 4000,
          recipientType: 'user',
          recipientId: 'janet@point.test',
        ),
      ];
    final container = _container(
      api,
      _Crypto({'lat': 41.88, 'lon': -87.63, 'timestamp': 3000}),
    );
    addTearDown(container.dispose);
    await container.read(authControllerProvider.future);
    final relay = container.read(relayControllerProvider);
    await relay.start(_session);

    final diff = await relay.reconcileCurrentFixes([_peer]);

    expect(diff.updatedPeers, isEmpty);
    expect(container.read(livePresenceProvider), isNot(contains(_peer)));
  });

  test(
    'successful authorization refresh prunes revoked cached peers',
    () async {
      const revoked = 'revoked@point.test';
      FlutterSecureStorage.setMockInitialValues({
        'point.relay.fix-cache.${_session.userId}': jsonEncode({
          'version': 1,
          'fixes': {
            _peer: {
              'data': {'lat': 41.9, 'lon': -87.6, 'timestamp': 5000},
            },
            revoked: {
              'data': {'lat': 42.0, 'lon': -87.7, 'timestamp': 4000},
              'access': 'permanent',
            },
          },
        }),
      });
      final api = _FakeApi()
        ..shares = const [
          {'user_id': _peer, 'display_name': 'Parker'},
        ];
      final container = _container(
        api,
        _Crypto({'lat': 41.9, 'lon': -87.6, 'timestamp': 5000}),
      );
      addTearDown(container.dispose);
      await container.read(authControllerProvider.future);
      final relay = container.read(relayControllerProvider);
      await relay.start(_session);
      expect(container.read(livePresenceProvider), contains(revoked));

      await container.read(peopleControllerProvider.future);
      await relay.reconcileCurrentFixes([_peer]);

      expect(container.read(livePresenceProvider), isNot(contains(revoked)));
      expect(relay.cachedPeerFixes, isNot(contains(revoked)));
    },
  );
}
