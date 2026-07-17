import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/location/data/location_service.dart';
import 'package:point_app/features/people/people_controller.dart';
import 'package:point_app/features/relay/reconnect_policy.dart';
import 'package:point_app/features/relay/relay_controller.dart';
import 'package:point_app/features/relay/relay_queue.dart';
import 'package:point_app/services/api/models.dart';

/// Keeps the accept path off platform plugins: the only provider the accept
/// path reads is [peopleControllerProvider], and the real notifier's `build()` reads
/// the session store (a secure-storage plugin, absent in a headless unit test).
/// This stub short-circuits that so the go-dark dedup rule can be exercised at
/// the controller level with no WS/crypto/auth harness.
class _StubPeople extends PeopleController {
  @override
  Future<List<Person>> build() async => const [];
}

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

    test('peek reads in order WITHOUT removing; ackThrough removes through seq '
        'and persists (R10 — removal only after a confirmed send)', () async {
      final store = MemoryRelayStore();
      final q = RelayQueue(store: store);
      await q.load();
      for (var i = 0; i < 5; i++) {
        await q.enqueue('bob@x', 'f$i');
      }
      final batch = q.peek(max: 3);
      expect(batch.map((e) => e.frame), ['f0', 'f1', 'f2']);
      // Peek must NOT remove — the durable copy stays until delivery is
      // confirmed. A restore right now still has all five.
      expect(q.length, 5);
      final reloadedPeek = RelayQueue(store: store);
      await reloadedPeek.load();
      expect(reloadedPeek.length, 5);

      // Confirmed → remove exactly the delivered batch (by seq) and persist.
      await q.ackThrough(batch.last.seq);
      expect(q.items.map((e) => e.frame), ['f3', 'f4']);
      final reloaded = RelayQueue(store: store);
      await reloaded.load();
      expect(reloaded.length, 2);
    });

    test('R10 mid-delivery kill: a crash between peek (send) and ack loses '
        'NOTHING — the whole batch survives to resend, incl. the last fix',
        () async {
      final store = MemoryRelayStore();
      final q = RelayQueue(store: store);
      await q.load();
      await q.enqueue('bob@x', 'f0');
      await q.enqueue('bob@x', 'f1');
      await q.enqueue('carol@x', 'f2'); // the last pre-offline fix

      // Peek the batch and "send" it (sink.add) — but the process is killed
      // before any ack persists. Model the kill as a restore from the store.
      final batch = q.peek(max: 20);
      expect(batch, hasLength(3));
      // No ackThrough happened (killed mid-flight).
      final afterKill = RelayQueue(store: store);
      await afterKill.load();
      expect(
        afterKill.items.map((e) => e.frame),
        ['f0', 'f1', 'f2'],
        reason: 'D-019: a mid-delivery kill drops nothing — never removed '
            'before a confirmed send',
      );
    });

    test('ackThrough is seq-keyed, so a capacity eviction of an in-flight item '
        'never removes the wrong (newer) fix', () async {
      final store = MemoryRelayStore();
      final q = RelayQueue(store: store, capacity: 3);
      await q.load();
      await q.enqueue('bob@x', 'b0'); // seq 0
      await q.enqueue('bob@x', 'b1'); // seq 1
      final batch = q.peek(max: 2); // [b0(0), b1(1)] in flight
      // A newer bob fix arrives + evicts the stale in-flight b0 (capacity).
      await q.enqueue('bob@x', 'b2'); // seq 2, evicts b0
      await q.enqueue('bob@x', 'b3'); // seq 3, evicts b1
      // Confirm the in-flight batch (through seq 1). b0/b1 are already gone; the
      // newer b2/b3 (higher seq) must be preserved, not dropped.
      await q.ackThrough(batch.last.seq);
      expect(q.items.map((e) => e.frame), ['b2', 'b3']);
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

  group('_acceptPeerFix liveness-dedup (the go-dark-critical relay rule)', () {
    RelayController relayIn(ProviderContainer container) {
      addTearDown(container.dispose);
      return container.read(relayControllerProvider);
    }

    ProviderContainer container() => ProviderContainer(
      overrides: [peopleControllerProvider.overrideWith(_StubPeople.new)],
    );

    test('a keepalive with the SAME position but a NEWER alive_at is ACCEPTED, '
        'not dropped as a duplicate', () async {
      final relay = relayIn(container());
      const user = 'eli@point.dev';
      const positionTs = 1000; // the frozen (parked) position clock

      // First keepalive establishes the peer + the liveness high-water mark.
      expect(
        await relay.debugAcceptPeerFix(user, {
          'lat': 38.6,
          'lon': -90.2,
          'timestamp': positionTs,
          'alive_at': 2000,
          'parked': 1,
        }),
        isTrue,
      );

      // Same POSITION time, NEWER liveness — the exact parked-keepalive shape.
      // Dedup on `timestamp` would drop this as a duplicate and the device would
      // wrongly go dark; dedup on `alive_at` accepts it.
      expect(
        await relay.debugAcceptPeerFix(user, {
          'lat': 38.6,
          'lon': -90.2,
          'timestamp': positionTs,
          'alive_at': 5000,
          'parked': 1,
        }),
        isTrue,
        reason: 'a newer alive_at is fresh liveness, not a duplicate position',
      );
      // Liveness advanced, but the REAL position time is still preserved.
      expect(relay.cachedPeerFixes[user]!.aliveAt, 5000);
      expect(
        relay.cachedPeerFixes[user]!.timestamp,
        positionTs,
        reason: 'the parked position clock is never faked forward',
      );

      // A keepalive whose liveness did NOT advance IS a duplicate → dropped.
      expect(
        await relay.debugAcceptPeerFix(user, {
          'lat': 38.6,
          'lon': -90.2,
          'timestamp': positionTs,
          'alive_at': 4000,
          'parked': 1,
        }),
        isFalse,
        reason: 'no forward liveness ⇒ a genuine duplicate',
      );
    });

    test('a snapshot row validates on the liveness clock the server stored as '
        'client_timestamp (parked position < that outer timestamp)', () async {
      final relay = relayIn(container());

      // A reconnecting snapshot: the sender now emits `alive_at` (5000) as the
      // OUTER frame timestamp, so the server stores client_timestamp = 5000
      // while the blob's position `timestamp` stays 1000. The accept must
      // validate `expectedTimestamp` against the LIVENESS clock — validating it
      // against the position clock would reject every parked snapshot row and a
      // reconnecting/cold-start viewer would go dark.
      expect(
        await relay.debugAcceptPeerFix('mara@point.dev', {
          'lat': 1.0,
          'lon': 2.0,
          'timestamp': 1000,
          'alive_at': 5000,
          'parked': 1,
        }, expectedTimestamp: 5000),
        isTrue,
      );
    });
  });
}
