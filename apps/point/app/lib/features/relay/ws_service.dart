import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:point_app/features/relay/reconnect_policy.dart';
import 'package:point_app/features/relay/relay_queue.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

/// The live location transport (GO-bar #3). Auth is the FIRST message, never in
/// the URL. Outbound fixes go through the durable [RelayQueue] so a disconnect
/// or a killed process never drops location; reconnect uses jittered backoff
/// ([ReconnectPolicy]) and the queue is flushed only once the socket is proven
/// healthy (`auth.ok`). Fixes the two legacy bugs: RAM-only buffer and
/// reset-backoff-on-open.
class WsService {
  WsService({
    required this.wsUrl,
    required RelayQueue queue,
    ReconnectPolicy? policy,
    WebSocketChannel Function(Uri)? connect,
  })  : _queue = queue,
        _policy = policy ?? ReconnectPolicy(),
        _connect = connect ?? WebSocketChannel.connect;

  final String wsUrl;
  final RelayQueue _queue;
  final ReconnectPolicy _policy;
  final WebSocketChannel Function(Uri) _connect;

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _sub;
  Timer? _reconnectTimer;
  String? _token;
  bool _authed = false;
  bool _disposed = false;

  final _incoming = StreamController<Map<String, dynamic>>.broadcast();

  /// Server → client frames (location.broadcast, presence.update, mls.message…).
  Stream<Map<String, dynamic>> get incoming => _incoming.stream;

  bool get isConnected => _authed;

  Future<void> start(String token) async {
    _token = token;
    await _queue.load();
    _open();
  }

  void _open() {
    if (_disposed) return;
    _authed = false;
    try {
      final channel = _connect(Uri.parse(wsUrl));
      _channel = channel;
      // Auth as the first frame.
      channel.sink.add(jsonEncode({'type': 'auth', 'token': _token}));
      _sub = channel.stream.listen(
        _onFrame,
        onDone: _onClosed,
        onError: (Object e) {
          if (kDebugMode) debugPrint('ws error: $e');
          _onClosed();
        },
        cancelOnError: true,
      );
    } on Object catch (e) {
      if (kDebugMode) debugPrint('ws connect failed: $e');
      _scheduleReconnect();
    }
  }

  void _onFrame(dynamic raw) {
    final Map<String, dynamic> msg;
    try {
      msg = jsonDecode(raw as String) as Map<String, dynamic>;
    } on Object {
      return;
    }
    if (msg['type'] == 'auth.ok') {
      // Proven healthy: NOW reset the backoff and flush the durable queue.
      _authed = true;
      _policy.onConnected();
      unawaited(_flush());
      return;
    }
    _incoming.add(msg);
  }

  void _onClosed() {
    _authed = false;
    _sub?.cancel();
    _sub = null;
    _channel = null;
    _scheduleReconnect();
  }

  void _scheduleReconnect() {
    if (_disposed || _token == null) return;
    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(_policy.nextDelay(), _open);
  }

  /// Enqueue-or-send a fix. When disconnected it's persisted for later; when
  /// connected it's sent and, on any send error, re-enqueued.
  Future<void> send(String audience, String frame) async {
    await _queue.enqueue(audience, frame);
    if (_authed) await _flush();
  }

  bool _flushing = false;

  Future<void> _flush() async {
    if (!_authed || _flushing) return;
    _flushing = true;
    try {
      while (_authed && !_queue.isEmpty) {
        final batch = await _queue.drain(max: 20);
        try {
          for (final item in batch) {
            _channel!.sink.add(item.frame);
          }
        } on Object {
          // Send failed mid-batch — put them back at the front and stop.
          await _queue.requeueFront(batch);
          break;
        }
      }
    } finally {
      _flushing = false;
    }
  }

  Future<void> dispose() async {
    _disposed = true;
    _reconnectTimer?.cancel();
    await _sub?.cancel();
    await _channel?.sink.close();
    await _incoming.close();
  }
}
