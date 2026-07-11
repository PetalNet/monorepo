import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
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

  @override
  Stream<dynamic> get stream => _in.stream;

  @override
  WebSocketSink get sink => _sink;

  @override
  dynamic noSuchMethod(Invocation i) => super.noSuchMethod(i);
}

class _FakeSink implements WebSocketSink {
  void Function(dynamic)? onAdd;
  @override
  void add(dynamic data) => onAdd?.call(data);
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
      ws.incoming.listen(received.add);
      await ws.start('t');
      channel
        ..push({'type': 'auth.ok'})
        ..push({'type': 'location.broadcast', 'sender_id': 'bob@x'});
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(received.any((m) => m['type'] == 'location.broadcast'), isTrue);
      // auth.ok is consumed internally, not surfaced.
      expect(received.any((m) => m['type'] == 'auth.ok'), isFalse);
      await ws.dispose();
    });
  });
}
