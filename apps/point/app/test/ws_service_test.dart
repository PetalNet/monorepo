import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:point_app/features/relay/reconnect_policy.dart';
import 'package:point_app/features/relay/relay_queue.dart';
import 'package:point_app/features/relay/ws_service.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

/// Minimal fake channel: captures outbound frames, lets the test push inbound.
class _FakeChannel implements WebSocketChannel {
  _FakeChannel() {
    _sink.onAdd = (v) => sent.add(v as String);
  }

  final _in = StreamController<dynamic>.broadcast();
  final sent = <String>[];
  final _sink = _FakeSink();

  void push(Map<String, dynamic> msg) => _in.add(jsonEncode(msg));

  Future<void> closeFromServer() => _in.close();

  @override
  Stream<dynamic> get stream => _in.stream;

  @override
  WebSocketSink get sink => _sink;

  @override
  dynamic noSuchMethod(Invocation i) => super.noSuchMethod(i);
}

class _FakeSink implements WebSocketSink {
  void Function(dynamic)? onAdd;
  bool throwOnAdd = false;
  @override
  void add(dynamic data) {
    if (throwOnAdd) throw StateError('socket send failed');
    onAdd?.call(data);
  }

  @override
  Future<void> close([int? closeCode, String? closeReason]) async {}
  @override
  dynamic noSuchMethod(Invocation i) => super.noSuchMethod(i);
}

void main() {
  group('WsService (GO-bar #3 orchestration)', () {
    test('sends auth first, flushes the durable queue on auth.ok', () async {
      final queue = RelayQueue(store: MemoryRelayStore());
      await queue.load();
      // Queued while "offline" (before connect) — must survive to flush.
      await queue.enqueue('bob@x', 'fix-A');
      await queue.enqueue('bob@x', 'fix-B');

      late _FakeChannel channel;
      final ws = WsService(
        wsUrl: 'ws://test/ws',
        queue: queue,
        connect: (_) => channel = _FakeChannel(),
      );
      await ws.start('token-123');

      // First frame is auth, in the URL-free handshake.
      expect(channel.sent.length, 1);
      final auth = jsonDecode(channel.sent.first) as Map<String, dynamic>;
      expect(auth['type'], 'auth');
      expect(auth['token'], 'token-123');
      expect(ws.isConnected, isFalse);

      // Server proves the socket healthy → queue flushes in order.
      channel.push({'type': 'auth.ok', 'user_id': 'me@x'});
      await Future<void>.delayed(const Duration(milliseconds: 20));

      expect(ws.isConnected, isTrue);
      expect(channel.sent.sublist(1), ['fix-A', 'fix-B']);
      expect(queue.isEmpty, isTrue);
      await ws.dispose();
    });

    test('a fix sent while connected goes out immediately', () async {
      final queue = RelayQueue(store: MemoryRelayStore());
      await queue.load();
      late _FakeChannel channel;
      final ws = WsService(
        wsUrl: 'ws://test/ws',
        queue: queue,
        connect: (_) => channel = _FakeChannel(),
      );
      await ws.start('t');
      channel.push({'type': 'auth.ok'});
      await Future<void>.delayed(const Duration(milliseconds: 20));

      await ws.send('bob@x', 'live-fix');
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(channel.sent.contains('live-fix'), isTrue);
      expect(queue.isEmpty, isTrue);
      await ws.dispose();
    });

    test('incoming non-auth frames surface on the stream', () async {
      final queue = RelayQueue(store: MemoryRelayStore());
      await queue.load();
      late _FakeChannel channel;
      final ws = WsService(
        wsUrl: 'ws://test/ws',
        queue: queue,
        connect: (_) => channel = _FakeChannel(),
      );
      final received = <Map<String, dynamic>>[];
      final states = <WsConnectionState>[];
      ws.incoming.listen(received.add);
      ws.connectionStates.listen(states.add);
      await ws.start('t');
      channel
        ..push({'type': 'auth.ok'})
        ..push({'type': 'location.broadcast', 'sender_id': 'bob@x'});
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(received.any((m) => m['type'] == 'location.broadcast'), isTrue);
      // auth.ok is consumed internally, not surfaced.
      expect(received.any((m) => m['type'] == 'auth.ok'), isFalse);
      expect(states, contains(WsConnectionState.authenticated));
      await ws.dispose();
    });

    test('re-authentication is surfaced after a dropped connection', () async {
      final channels = <_FakeChannel>[];
      final ws = WsService(
        wsUrl: 'ws://test/ws',
        queue: RelayQueue(store: MemoryRelayStore()),
        policy: ReconnectPolicy(base: Duration.zero, jitter: 0),
        connect: (_) {
          final channel = _FakeChannel();
          channels.add(channel);
          return channel;
        },
      );
      final authenticated = <WsConnectionState>[];
      ws.connectionStates.listen((state) {
        if (state == WsConnectionState.authenticated) {
          authenticated.add(state);
        }
      });

      await ws.start('t');
      channels.single.push({'type': 'auth.ok'});
      await Future<void>.delayed(const Duration(milliseconds: 20));
      await channels.single.closeFromServer();
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(channels, hasLength(2));
      channels.last.push({'type': 'auth.ok'});
      await Future<void>.delayed(const Duration(milliseconds: 20));

      expect(authenticated, hasLength(2));
      await ws.dispose();
    });

    test(
      'health tracks connection, durable queue, and explicit retry',
      () async {
        final queue = RelayQueue(store: MemoryRelayStore());
        await queue.load();
        await queue.enqueue('bob@x', 'queued-fix');
        final channels = <_FakeChannel>[];
        final ws = WsService(
          wsUrl: 'ws://test/ws',
          queue: queue,
          policy: ReconnectPolicy(
            base: const Duration(hours: 1),
            jitter: 0,
          ),
          connect: (_) {
            final channel = _FakeChannel();
            channels.add(channel);
            return channel;
          },
        );
        final health = <WsHealth>[];
        ws.health.listen(health.add);

        await ws.start('t');
        await Future<void>.delayed(Duration.zero);
        expect(health.last.connection, WsConnectionState.connecting);
        expect(health.last.queueDepth, 1);

        channels.single.push({'type': 'auth.ok'});
        await Future<void>.delayed(const Duration(milliseconds: 20));
        expect(health.last.connection, WsConnectionState.authenticated);
        expect(health.last.queueDepth, 0);
        expect(health.last.lastAuthenticatedAt, isNotNull);

        await channels.single.closeFromServer();
        await Future<void>.delayed(Duration.zero);
        expect(health.last.connection, WsConnectionState.disconnected);
        await ws.retryNow();
        expect(channels, hasLength(2));
        await Future<void>.delayed(Duration.zero);
        expect(health.last.connection, WsConnectionState.connecting);

        channels.last.push({'type': 'auth.ok'});
        await Future<void>.delayed(const Duration(milliseconds: 20));
        channels.last._sink.throwOnAdd = true;
        await ws.send('bob@x', 'retry-me');
        await Future<void>.delayed(Duration.zero);
        expect(health.last.connection, WsConnectionState.disconnected);
        expect(health.last.queueDepth, 1);

        channels.last._sink.throwOnAdd = false;
        await ws.retryNow();
        channels.last.push({'type': 'auth.ok'});
        await Future<void>.delayed(const Duration(milliseconds: 20));
        expect(health.last.connection, WsConnectionState.authenticated);
        expect(health.last.queueDepth, 0);
        await ws.dispose();
      },
    );
  });
}
