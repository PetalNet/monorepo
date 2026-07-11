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

  /// Drain up to [max] items in order (oldest first), removing them and
  /// persisting the shrunken queue. The caller sends them; on send failure it
  /// should re-enqueue (or not drain until connected).
  Future<List<RelayItem>> drain({int max = 50}) async {
    final take = _items.take(max).toList();
    _items.removeRange(0, take.length);
    await _persist();
    return take;
  }

  /// Re-queue items at the FRONT (a flush that failed mid-way), preserving order.
  Future<void> requeueFront(List<RelayItem> items) async {
    _items.insertAll(0, items);
    await _persist();
  }

  Future<void> clear() async {
    _items.clear();
    await _persist();
  }

  Future<void> _persist() =>
      _store.write(jsonEncode(_items.map((e) => e.toJson()).toList()));
}
