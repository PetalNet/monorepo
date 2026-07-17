import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:point_app/features/relay/reconnect_policy.dart';
import 'package:point_app/features/relay/relay_queue.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

/// Observable transport state. Only [authenticated] is healthy enough to
/// start authoritative catch-up; a TCP/WebSocket open alone is not.
enum WsConnectionState { disconnected, connecting, authenticated }

/// A complete transport snapshot for trust-sensitive presentation. Queue
/// depth is included here so a connected socket with unsent fixes cannot be
/// mistaken for fully live.
@immutable
class WsHealth {
  const WsHealth({
    required this.connection,
    required this.queueDepth,
    this.lastAuthenticatedAt,
  });

  final WsConnectionState connection;
  final int queueDepth;
  final DateTime? lastAuthenticatedAt;

  bool get isAuthenticated => connection == WsConnectionState.authenticated;
}

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
  }) : _queue = queue,
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
  int _connectionEpoch = 0;

  final _incoming = StreamController<Map<String, dynamic>>.broadcast();
  final _connectionStates = StreamController<WsConnectionState>.broadcast();
  final _health = StreamController<WsHealth>.broadcast();
  WsConnectionState _connectionState = WsConnectionState.disconnected;
  DateTime? _lastAuthenticatedAt;

  /// Server → client frames (location.broadcast, presence.update, mls.message…).
  Stream<Map<String, dynamic>> get incoming => _incoming.stream;

  /// Emits every socket transition, including every successful re-auth. The
  /// relay uses this durable boundary to reconcile state after missed frames.
  Stream<WsConnectionState> get connectionStates => _connectionStates.stream;

  /// Current and future transport health, including durable outbound work.
  WsHealth get currentHealth => WsHealth(
    connection: _connectionState,
    queueDepth: _queue.length,
    lastAuthenticatedAt: _lastAuthenticatedAt,
  );
  Stream<WsHealth> get health => _health.stream;

  bool get isConnected => _authed;

  Future<void> start(String token) async {
    _token = token;
    await _queue.load();
    _open();
  }

  /// Skip the backoff delay after an explicit user retry. An authenticated
  /// connection is left alone; its caller can request an authoritative sync.
  Future<void> retryNow() async {
    if (_disposed || _token == null || _authed) return;
    _reconnectTimer?.cancel();
    _connectionEpoch++;
    await _sub?.cancel();
    _sub = null;
    await _channel?.sink.close();
    _channel = null;
    _open();
  }

  void _open() {
    if (_disposed) return;
    _authed = false;
    final epoch = ++_connectionEpoch;
    _emitHealth(WsConnectionState.connecting);
    try {
      final channel = _connect(Uri.parse(wsUrl));
      _channel = channel;
      // Auth as the first frame.
      channel.sink.add(jsonEncode({'type': 'auth', 'token': _token}));
      _sub = channel.stream.listen(
        (raw) => _onFrame(raw, epoch),
        onDone: () => _onClosed(epoch),
        onError: (Object e) {
          if (kDebugMode) debugPrint('ws error: $e');
          _onClosed(epoch);
        },
        cancelOnError: true,
      );
    } on Object catch (e) {
      if (kDebugMode) debugPrint('ws connect failed: $e');
      _emitHealth(WsConnectionState.disconnected);
      _scheduleReconnect();
    }
  }

  void _onFrame(dynamic raw, int epoch) {
    if (epoch != _connectionEpoch || _disposed) return;
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
      _lastAuthenticatedAt = DateTime.now();
      _emitHealth(WsConnectionState.authenticated);
      unawaited(_flush());
      return;
    }
    _incoming.add(msg);
  }

  void _onClosed(int epoch) {
    if (epoch != _connectionEpoch || _disposed) return;
    _authed = false;
    _emitHealth(WsConnectionState.disconnected);
    unawaited(_sub?.cancel());
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
    _emitHealth();
    if (_authed) await _flush();
  }

  Future<void> flushNow() => _flush();

  /// Send an ephemeral control frame (e.g. a viewer's Layer-4 watcher-wake
  /// nudge). Unlike [send] it is NOT persisted to the durable [RelayQueue], so
  /// a transient signal is never resent after a reconnect — a stale "wake up"
  /// replayed minutes later would be wrong. Dropped silently if the socket is
  /// not authenticated (the frame is advisory; a real interaction reconciles
  /// state anyway).
  void sendEphemeral(String frame) {
    if (!_authed) return;
    _channel?.sink.add(frame);
  }

  bool _flushing = false;

  Future<void> _flush() async {
    if (!_authed || _flushing) return;
    _flushing = true;
    try {
      while (_authed && !_queue.isEmpty) {
        // R10: PEEK — do not remove yet. The durable copy stays until the send
        // is confirmed, so a crash mid-flight can't lose the batch.
        final batch = _queue.peek(max: 20);
        if (batch.isEmpty) break;
        try {
          for (final item in batch) {
            _channel!.sink.add(item.frame);
          }
        } on Object {
          // Send failed mid-batch. The batch was never removed (peek, not
          // drain), so nothing is lost — it stays durably queued in order and
          // resends on reconnect. Mark the socket dead and stop.
          _onClosed(_connectionEpoch);
          break;
        }
        // The socket accepted the whole batch: only NOW remove it from the
        // durable queue + persist (R10 — never before the send). If the process
        // dies before this line, the batch survives to resend after restart.
        await _queue.ackThrough(batch.last.seq);
        _emitHealth();
      }
    } finally {
      _flushing = false;
    }
  }

  Future<void> dispose() async {
    _disposed = true;
    _connectionEpoch++;
    _reconnectTimer?.cancel();
    await _sub?.cancel();
    await _channel?.sink.close();
    await _incoming.close();
    await _connectionStates.close();
    await _health.close();
  }

  void _emitHealth([WsConnectionState? connection]) {
    if (connection != null) {
      _connectionState = connection;
      if (!_connectionStates.isClosed) _connectionStates.add(connection);
    }
    if (!_health.isClosed) _health.add(currentHealth);
  }
}
