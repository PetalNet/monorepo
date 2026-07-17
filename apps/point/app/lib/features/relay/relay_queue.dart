import 'dart:convert';

/// A single outbound relay item — an already-MLS-encrypted location frame,
/// opaque here. `audience` (user id or group id) lets the queue collapse stale
/// fixes: only the newest fix per audience matters for a live dot, so when the
/// queue is full we drop older same-audience items instead of newer ones.
class RelayItem {
  const RelayItem({
    required this.audience,
    required this.frame,
    required this.seq,
  });

  factory RelayItem.fromJson(Map<String, dynamic> j) => RelayItem(
        audience: j['a'] as String,
        frame: j['f'] as String,
        seq: j['s'] as int,
      );

  /// Routing key (recipient user/group).
  final String audience;

  /// The serialized WS text frame (contains base64 MLS ciphertext).
  final String frame;

  /// Monotonic sequence for ordering.
  final int seq;

  Map<String, dynamic> toJson() => {'a': audience, 'f': frame, 's': seq};
}

/// Persistence backend for the queue — a tiny key/value the queue serializes to.
/// Abstracted so tests use an in-memory impl and the app uses secure storage /
/// shared prefs.
abstract interface class RelayStore {
  Future<String?> read();
  Future<void> write(String value);
}

/// In-memory store (tests).
class MemoryRelayStore implements RelayStore {
  String? _v;
  @override
  Future<String?> read() async => _v;
  @override
  Future<void> write(String value) async => _v = value;
}

/// The **durable outbound queue** (GO-bar #3). The legacy relay buffer was
/// RAM-only, so a backgrounded/killed process or a disconnect dropped every
/// buffered fix. This persists across restarts, bounds its size, and — because
/// only the freshest fix per audience is useful for a live location — evicts
/// stale same-audience items first when capacity is hit.
class RelayQueue {
  RelayQueue({required RelayStore store, this.capacity = 500}) : _store = store;

  final RelayStore _store;
  final int capacity;
  final List<RelayItem> _items = [];
  int _seq = 0;
  bool _loaded = false;

  /// Load persisted items (call once on boot).
  Future<void> load() async {
    if (_loaded) return;
    final raw = await _store.read();
    if (raw != null && raw.isNotEmpty) {
      final list = (jsonDecode(raw) as List<dynamic>)
          .map((e) => RelayItem.fromJson(e as Map<String, dynamic>))
          .toList();
      _items
        ..clear()
        ..addAll(list);
      _seq = _items.isEmpty ? 0 : _items.last.seq + 1;
    }
    _loaded = true;
  }

  int get length => _items.length;
  bool get isEmpty => _items.isEmpty;
  List<RelayItem> get items => List.unmodifiable(_items);

  /// Enqueue a fix for an audience. Persists immediately so a crash can't lose
  /// it. When full, drop the oldest item for the SAME audience first (its data
  /// is superseded by this newer fix); otherwise drop the global oldest.
  Future<void> enqueue(String audience, String frame) async {
    _items.add(RelayItem(audience: audience, frame: frame, seq: _seq++));
    if (_items.length > capacity) {
      final staleIdx = _items.indexWhere((i) => i.audience == audience);
      _items.removeAt(staleIdx >= 0 && staleIdx < _items.length - 1
          ? staleIdx
          : 0);
    }
    await _persist();
  }

  /// Peek up to [max] items in order (oldest first) WITHOUT removing them — the
  /// durable copy stays put until delivery is confirmed.
  ///
  /// R10: the old `drain` removed + persisted the shrunken queue BEFORE the send.
  /// But `sink.add()` is not server receipt — a half-open socket or an OS kill
  /// in the window between the persisted removal and the frame actually reaching
  /// the server lost the whole batch (including the last pre-offline fix),
  /// breaking the D-019 "never drops" promise. Now the caller sends the peeked
  /// batch and only [ackThrough]s it once the socket has accepted it, so a crash
  /// mid-flight leaves the batch durably queued to resend on reconnect.
  List<RelayItem> peek({int max = 50}) => _items.take(max).toList();

  /// Remove every still-queued item up to and including [throughSeq] and
  /// persist — the durable removal, performed only AFTER a send is confirmed
  /// (never on enqueue-to-socket). Keyed on the monotonic [RelayItem.seq], not a
  /// front index, so it stays correct even if a capacity eviction or a newer
  /// same-audience enqueue reshuffled the queue while the batch was in flight;
  /// items newer than the batch (higher seq) are preserved.
  Future<void> ackThrough(int throughSeq) async {
    _items.removeWhere((i) => i.seq <= throughSeq);
    await _persist();
  }

  Future<void> clear() async {
    _items.clear();
    await _persist();
  }

  Future<void> _persist() =>
      _store.write(jsonEncode(_items.map((e) => e.toJson()).toList()));
}
