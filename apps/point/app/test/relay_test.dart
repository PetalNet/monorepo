import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:point_app/features/location/data/location_service.dart';
import 'package:point_app/features/relay/reconnect_policy.dart';
import 'package:point_app/features/relay/relay_controller.dart';
import 'package:point_app/features/relay/relay_queue.dart';

void main() {
  test('location payload carries encrypted horizontal accuracy additively', () {
    const fix = Fix(
      lat: 38.627,
      lon: -90.1994,
      speed: 1.5,
      accuracy: 7.25,
      timestampMs: 1234,
    );

    expect(locationFixPayload(fix), {
      'lat': 38.627,
      'lon': -90.1994,
      'speed': 1.5,
      'accuracy': 7.25,
      'timestamp': 1234,
    });
    expect(
      const PeerFix(
        userId: 'old-client@example.test',
        data: {'lat': 1, 'lon': 2, 'timestamp': 3},
      ).accuracy,
      isNull,
    );
    expect(
      locationFixPayload(
        const Fix(
          lat: 38.627,
          lon: -90.1994,
          speed: 0,
          accuracy: 0,
          timestampMs: 1235,
        ),
      ),
      isNot(contains('accuracy')),
    );
  });

  test('a live fix omits alive_at/parked; a parked keepalive carries the REAL '
      'position time plus a newer liveness clock', () {
    // A live fix: aliveAt == position, not parked → byte-for-byte as before
    // (old clients keep parsing it; the payload gains nothing).
    const live = Fix(
      lat: 1,
      lon: 2,
      speed: 3,
      accuracy: 0,
      timestampMs: 1000,
    );
    final livePayload = locationFixPayload(live);
    expect(livePayload.containsKey('alive_at'), isFalse);
    expect(livePayload.containsKey('parked'), isFalse);
    expect(livePayload['timestamp'], 1000);

    // A parked keepalive: real (older) position time is preserved, liveness is
    // stamped now, and the parked flag is set.
    const keepalive = Fix(
      lat: 1,
      lon: 2,
      speed: 0,
      accuracy: 0,
      timestampMs: 1000, // REAL last-sample time — NOT re-stamped to now
      aliveAtMs: 5000, // alive as of now
      parked: true,
    );
    final payload = locationFixPayload(keepalive);
    expect(payload['timestamp'], 1000, reason: 'position time is not faked');
    expect(payload['alive_at'], 5000, reason: 'liveness carried separately');
    expect(payload['parked'], 1);

    // And the receiver reads both clocks + the flag back out.
    final peer = PeerFix(userId: 'p@x', data: Map<String, dynamic>.from(payload));
    expect(peer.timestamp, 1000);
    expect(peer.aliveAt, 5000);
    expect(peer.parked, isTrue);

    // An old payload (no alive_at/parked): liveness falls back to position.
    const old = PeerFix(
      userId: 'p@x',
      data: {'lat': 1, 'lon': 2, 'timestamp': 1000},
    );
    expect(old.aliveAt, 1000);
    expect(old.parked, isFalse);
  });

  group('RelayQueue (durable outbound queue, GO-bar #3)', () {
    test('persists across a reload (survives restart)', () async {
      final store = MemoryRelayStore();
      final q = RelayQueue(store: store);
      await q.load();
      await q.enqueue('bob@x', 'frame1');
      await q.enqueue('bob@x', 'frame2');

      // Simulate a restart: a fresh queue over the same store.
      final q2 = RelayQueue(store: store);
      await q2.load();
      expect(q2.length, 2);
      expect(q2.items.first.frame, 'frame1');
    });

    test('drain removes in order and shrinks the persisted queue', () async {
      final store = MemoryRelayStore();
      final q = RelayQueue(store: store);
      await q.load();
      for (var i = 0; i < 5; i++) {
        await q.enqueue('bob@x', 'f$i');
      }
      final batch = await q.drain(max: 3);
      expect(batch.map((e) => e.frame), ['f0', 'f1', 'f2']);
      expect(q.length, 2);

      final reloaded = RelayQueue(store: store);
      await reloaded.load();
      expect(reloaded.length, 2);
    });

    test('requeueFront restores order after a failed flush', () async {
      final store = MemoryRelayStore();
      final q = RelayQueue(store: store);
      await q.load();
      await q.enqueue('bob@x', 'f0');
      await q.enqueue('bob@x', 'f1');
      final batch = await q.drain();
      await q.enqueue('bob@x', 'f2'); // arrived during the failed send
      await q.requeueFront(batch);
      expect(q.items.map((e) => e.frame), ['f0', 'f1', 'f2']);
    });

    test('evicts stale same-audience items when over capacity', () async {
      final store = MemoryRelayStore();
      final q = RelayQueue(store: store, capacity: 3);
      await q.load();
      await q.enqueue('bob@x', 'b0');
      await q.enqueue('carol@x', 'c0');
      await q.enqueue('bob@x', 'b1');
      // Over capacity: adding another bob fix should drop the stale bob (b0),
      // keeping carol's only fix and the newer bob fixes.
      await q.enqueue('bob@x', 'b2');
      expect(q.length, 3);
      final frames = q.items.map((e) => e.frame).toList();
      expect(frames.contains('c0'), isTrue, reason: 'other audience preserved');
      expect(frames.contains('b2'), isTrue, reason: 'newest fix kept');
      expect(
        frames.contains('b0'),
        isFalse,
        reason: 'stale same-audience dropped',
      );
    });
  });

  group('ReconnectPolicy (jittered backoff, GO-bar #3)', () {
    test('grows exponentially and is capped', () {
      final p = ReconnectPolicy(jitter: 0); // deterministic
      expect(p.nextDelay().inMilliseconds, 1000);
      expect(p.nextDelay().inMilliseconds, 2000);
      expect(p.nextDelay().inMilliseconds, 4000);
      // Keep going until capped.
      for (var i = 0; i < 10; i++) {
        p.nextDelay();
      }
      expect(p.nextDelay().inMilliseconds, 60000);
    });

    test('applies jitter (delays spread, not lockstep)', () {
      final p = ReconnectPolicy(
        base: const Duration(seconds: 4),
        random: Random(1),
      );
      final delays = List.generate(20, (_) {
        final d = p.nextDelay().inMilliseconds;
        p.onConnected(); // reset so we sample the same base repeatedly
        return d;
      });
      // With jitter, not all delays are identical.
      expect(delays.toSet().length, greaterThan(1));
      // Around the 4s base (+/- 50%): all within [2000, 6000].
      for (final d in delays) {
        expect(d, inInclusiveRange(2000, 6000));
      }
    });

    test('onConnected resets only on a proven-healthy connection', () {
      final p = ReconnectPolicy(jitter: 0)
        ..nextDelay()
        ..nextDelay();
      expect(p.attempt, 2);
      p.onConnected();
      expect(p.attempt, 0);
      // Next delay is back to base — not stuck high, not reset prematurely.
      expect(p.nextDelay().inMilliseconds, 1000);
    });
  });
}
