import 'package:flutter_test/flutter_test.dart';
import 'package:latlong2/latlong.dart';
import 'package:point_app/features/map/presentation/map_screen.dart';
import 'package:point_app/features/people/people_presence.dart';
import 'package:point_app/features/relay/relay_controller.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/theme/presence_tokens.dart';

void main() {
  final now = DateTime.fromMillisecondsSinceEpoch(1_000_000_000);
  int ago(Duration d) => now.subtract(d).millisecondsSinceEpoch;

  group('relativeSince', () {
    test('under 45s → now', () {
      expect(relativeSince(ago(const Duration(seconds: 10)), now: now), 'now');
    });
    test('minutes', () {
      expect(relativeSince(ago(const Duration(minutes: 4)), now: now), '4m');
    });
    test('hours', () {
      expect(relativeSince(ago(const Duration(hours: 2)), now: now), '2h');
    });
    test('days', () {
      expect(relativeSince(ago(const Duration(days: 3)), now: now), '3d');
    });
    test('does not call an implausible future timestamp now', () {
      expect(
        relativeSince(
          now.add(const Duration(minutes: 2)).millisecondsSinceEpoch,
          now: now,
        ),
        'time uncertain',
      );
    });
  });

  group('fixFreshness', () {
    test('moves from current to recent to stale at truthful boundaries', () {
      expect(
        fixFreshness(ago(const Duration(seconds: 44)), now: now),
        FixFreshness.current,
      );
      expect(
        fixFreshness(ago(const Duration(seconds: 45)), now: now),
        FixFreshness.recent,
      );
      expect(
        fixFreshness(ago(const Duration(minutes: 45)), now: now),
        FixFreshness.recent,
      );
      expect(
        fixFreshness(
          ago(const Duration(minutes: 45, milliseconds: 1)),
          now: now,
        ),
        FixFreshness.stale,
      );
    });

    test('(a) the dark threshold sits strictly above the parked heartbeat with '
        'real margin (heartbeat 30m < dark 45m) — the go-dark invariant', () {
      expect(parkedHeartbeat, const Duration(minutes: 30));
      expect(darkAfter, const Duration(minutes: 45));
      expect(
        parkedHeartbeat < darkAfter,
        isTrue,
        reason: 'a parked-alive phone checks in every 30m; the dark verdict '
            'must wait past that with margin or a live phone reads as dead',
      );
      expect(
        darkAfter - parkedHeartbeat,
        greaterThanOrEqualTo(const Duration(minutes: 10)),
        reason: 'margin covers acquisition + relay + the 30s viewer tick + skew',
      );
    });

    test('missing and far-future sample clocks are uncertain', () {
      expect(fixFreshness(null, now: now), FixFreshness.uncertain);
      expect(
        fixFreshness(
          now.add(const Duration(minutes: 2)).millisecondsSinceEpoch,
          now: now,
        ),
        FixFreshness.uncertain,
      );
    });
  });

  group('formatAccuracy', () {
    test('formats meter and kilometer precision without false decimals', () {
      expect(formatAccuracy(0.4), '±<1 m');
      expect(formatAccuracy(8.4), '±8 m');
      expect(formatAccuracy(1240), '±1.2 km');
    });

    test('omits absent and invalid precision', () {
      expect(formatAccuracy(null), isNull);
      expect(formatAccuracy(0), isNull);
      expect(formatAccuracy(-1), isNull);
      expect(formatAccuracy(double.nan), isNull);
    });
  });

  group('mergePresence', () {
    const away = Person(
      userId: 'eli@point.dev',
      displayName: 'Eli',
      presence: PresenceState.away,
    );

    test('no fix → unchanged (stays locationless)', () {
      final merged = mergePresence(away, null);
      expect(merged.hasLocation, isFalse);
      expect(merged.presence, PresenceState.away);
    });

    test('server online without a fix is truthful and locationless', () {
      final merged = mergePresence(
        away,
        null,
        serverPresence: PeerPresence(
          userId: away.userId,
          online: true,
          observedAt: now,
          battery: 72,
          activity: 'walking',
        ),
        now: now,
      );

      expect(merged.presence, PresenceState.live);
      expect(merged.hasLocation, isFalse);
      expect(merged.subtitle, 'Online · Waiting for location');
    });

    test('fresh fix → live, located, with freshness and accuracy', () {
      final fix = PeerFix(
        userId: 'eli@point.dev',
        data: {
          'lat': 38.6,
          'lon': -90.2,
          'accuracy': 11.7,
          'timestamp': ago(const Duration(minutes: 1)),
        },
      );
      final merged = mergePresence(away, fix, now: now);
      expect(merged.presence, PresenceState.live);
      expect(merged.hasLocation, isTrue);
      expect(merged.lat, 38.6);
      expect(merged.subtitle, 'Sharing · ±12 m · 1m');
    });

    test(
      'stale fix (> darkAfter) → DARK: frozen last-known + "Dark since"',
      () {
        final darkTs = ago(const Duration(minutes: 50));
        final fix = PeerFix(
          userId: 'eli@point.dev',
          data: {
            'lat': 38.6,
            'lon': -90.2,
            'accuracy': 24,
            'timestamp': darkTs,
          },
        );
        final merged = mergePresence(away, fix, now: now);
        expect(merged.presence, PresenceState.stale);
        // Frozen last-known coordinate is retained (shown in People/detail).
        expect(merged.hasLocation, isTrue);
        expect(merged.subtitle, startsWith('Last place · Dark since '));
        expect(
          merged.subtitle,
          'Last place · Dark since ${clockHm(darkTs)} · ±24 m',
        );
      },
    );

    test('(c) PARKED: recent keepalive + older position → alive & stationary, '
        'NOT dark and NOT falsely-fresh "now"', () {
      final parkedSince = ago(const Duration(hours: 2)); // hasn't moved in 2h
      final fix = PeerFix(
        userId: 'eli@point.dev',
        data: {
          'lat': 38.6,
          'lon': -90.2,
          'accuracy': 12,
          'timestamp': parkedSince, // REAL last-sample time (old)
          'alive_at': ago(const Duration(minutes: 5)), // last keepalive (recent)
          'parked': 1,
        },
      );
      final merged = mergePresence(away, fix, now: now);
      // Alive (not dark) …
      expect(merged.presence, PresenceState.live);
      expect(merged.hasLocation, isTrue);
      // … but honestly parked since the real sample time — never "now"/"5m".
      expect(merged.subtitle, 'Parked · here since ${clockHm(parkedSince)} · ±12 m');
      expect(merged.subtitle, isNot(contains('now')));
    });

    test('(d) no keepalive past the threshold → DARK since the last keepalive '
        '(a dead phone darks even though its last position looks placed)', () {
      final lastKeepalive = ago(const Duration(minutes: 50)); // > darkAfter
      final fix = PeerFix(
        userId: 'eli@point.dev',
        data: {
          'lat': 38.6,
          'lon': -90.2,
          'accuracy': 20,
          'timestamp': ago(const Duration(hours: 3)), // parked long ago
          'alive_at': lastKeepalive, // no keepalive since → dead
          'parked': 1,
        },
      );
      final merged = mergePresence(away, fix, now: now);
      expect(merged.presence, PresenceState.stale);
      expect(merged.hasLocation, isTrue);
      // "Dark since" the LAST keepalive we heard, not the ancient position.
      expect(
        merged.subtitle,
        'Last place · Dark since ${clockHm(lastKeepalive)} · ±20 m',
      );
    });

    test('a parked keepalive that is itself recent (just parked) still reads '
        'parked, not moving-live', () {
      final justParked = ago(const Duration(seconds: 20));
      final fix = PeerFix(
        userId: 'eli@point.dev',
        data: {
          'lat': 38.6,
          'lon': -90.2,
          'timestamp': justParked,
          'alive_at': justParked,
          'parked': 1,
        },
      );
      final merged = mergePresence(away, fix, now: now);
      expect(merged.presence, PresenceState.live);
      expect(merged.subtitle, 'Parked · here since ${clockHm(justParked)}');
    });

    test('server offline makes a fresh fix dark immediately', () {
      final disconnectedAt = now.subtract(const Duration(seconds: 5));
      final fix = PeerFix(
        userId: away.userId,
        data: {
          'lat': 38.6,
          'lon': -90.2,
          'timestamp': ago(const Duration(seconds: 10)),
        },
      );

      final merged = mergePresence(
        away,
        fix,
        serverPresence: PeerPresence(
          userId: away.userId,
          online: false,
          observedAt: disconnectedAt,
        ),
        now: now,
      );

      expect(merged.presence, PresenceState.stale);
      expect(merged.hasLocation, isTrue);
      expect(merged.lat, 38.6);
      expect(
        merged.subtitle,
        'Last place · Dark since '
        '${clockHm(disconnectedAt.millisecondsSinceEpoch)}',
      );
    });

    test('uncertain sender clock keeps last place but is not plotted live', () {
      final fix = PeerFix(
        userId: away.userId,
        data: {
          'lat': 38.6,
          'lon': -90.2,
          'accuracy': 9,
          'timestamp': now
              .add(const Duration(minutes: 2))
              .millisecondsSinceEpoch,
        },
      );

      final merged = mergePresence(away, fix, now: now);

      expect(merged.presence, PresenceState.away);
      expect(merged.hasLocation, isTrue);
      expect(merged.subtitle, 'Last place · Update time uncertain · ±9 m');
    });

    test('server offline without a fix is neutral dark, never ghosted', () {
      final merged = mergePresence(
        away,
        null,
        serverPresence: PeerPresence(
          userId: away.userId,
          online: false,
          observedAt: now,
        ),
        now: now,
      );

      expect(merged.presence, PresenceState.stale);
      expect(merged.presence, isNot(PresenceState.ghosted));
      expect(merged.hasLocation, isFalse);
    });

    test('fix without coordinates → unchanged', () {
      const fix = PeerFix(userId: 'eli@point.dev', data: {'speed': 1});
      expect(mergePresence(away, fix).hasLocation, isFalse);
    });

    test('same-server live person → plain status (no @server)', () {
      final fix = PeerFix(
        userId: 'eli@point.dev',
        data: {
          'lat': 1.0,
          'lon': 2.0,
          'timestamp': ago(const Duration(minutes: 3)),
        },
      );
      final merged = mergePresence(
        away,
        fix,
        selfDomain: 'point.dev',
        now: now,
      );
      expect(merged.subtitle, 'Sharing · 3m');
    });

    test('cross-server live person → @server shown quiet in status', () {
      const mara = Person(
        userId: 'mara@fieldstone.social',
        displayName: 'Mara',
        presence: PresenceState.away,
      );
      final fix = PeerFix(
        userId: 'mara@fieldstone.social',
        data: {
          'lat': 1.0,
          'lon': 2.0,
          'timestamp': ago(const Duration(minutes: 3)),
        },
      );
      final merged = mergePresence(
        mara,
        fix,
        selfDomain: 'point.dev',
        now: now,
      );
      expect(merged.subtitle, 'mara@fieldstone.social · 3m');
    });
  });

  test('PeerPresence uses the server observation clock', () {
    final presence = PeerPresence.fromFrame(const {
      'user_id': 'eli@point.dev',
      'online': false,
      'observed_at': 1234,
    });

    expect(presence.observedAt.millisecondsSinceEpoch, 1234);
  });

  group('PeerMarkerMotion', () {
    final observedAt = DateTime.utc(2026, 7, 13, 12);

    PeerFix fix({
      required double lat,
      required double lon,
      required Duration after,
    }) => PeerFix(
      userId: 'eli@point.dev',
      data: {
        'lat': lat,
        'lon': lon,
        'timestamp': observedAt.add(after).millisecondsSinceEpoch,
      },
      receivedAt: observedAt.add(after),
    );

    test('a first fix is a snapped target with no invented origin', () {
      final first = fix(lat: 38.60, lon: -90.20, after: Duration.zero);

      final motion = PeerMarkerMotion.initial(first);

      expect(motion.previous, isNull);
      expect(motion.target, same(first));
      expect(motion.duration(reducedMotion: false), Duration.zero);
    });

    test(
      'a plausible update retains both fixes and glides for bounded cadence',
      () {
        final first = fix(lat: 38.60, lon: -90.20, after: Duration.zero);
        final second = fix(
          lat: 38.6002,
          lon: -90.2002,
          after: const Duration(seconds: 2),
        );

        final motion = PeerMarkerMotion.initial(
          first,
        ).advance(second, now: second.receivedAt);

        expect(motion.previous, same(first));
        expect(motion.target, same(second));
        expect(
          motion.duration(reducedMotion: false),
          const Duration(milliseconds: 500),
        );
        expect(motion.duration(reducedMotion: true), Duration.zero);
      },
    );

    test('very stale updates snap instead of replaying old travel', () {
      final first = fix(lat: 38.60, lon: -90.20, after: Duration.zero);
      final stale = fix(
        lat: 38.61,
        lon: -90.21,
        after: const Duration(minutes: 4),
      );

      final motion = PeerMarkerMotion.initial(
        first,
      ).advance(stale, now: stale.receivedAt!.add(const Duration(minutes: 4)));

      expect(motion.duration(reducedMotion: false), Duration.zero);
    });

    test(
      'a very sparse update interval snaps even when the target is fresh',
      () {
        final first = fix(lat: 38.60, lon: -90.20, after: Duration.zero);
        final resumed = fix(
          lat: 38.61,
          lon: -90.21,
          after: const Duration(minutes: 4),
        );

        final motion = PeerMarkerMotion.initial(
          first,
        ).advance(resumed, now: resumed.receivedAt);

        expect(motion.duration(reducedMotion: false), Duration.zero);
      },
    );

    test('an impossible jump snaps instead of sweeping across the map', () {
      final first = fix(lat: 38.60, lon: -90.20, after: Duration.zero);
      final impossible = fix(
        lat: 40.7128,
        lon: -74.0060,
        after: const Duration(seconds: 2),
      );

      final motion = PeerMarkerMotion.initial(
        first,
      ).advance(impossible, now: impossible.receivedAt);

      expect(motion.duration(reducedMotion: false), Duration.zero);
    });
  });

  group('MapFollowState', () {
    test('focus enters explicit person-follow mode', () {
      expect(
        const MapFollowState.idle().follow('eli@point.dev'),
        const MapFollowState.following('eli@point.dev'),
      );
    });

    test('a user gesture disengages follow mode', () {
      expect(
        const MapFollowState.following('eli@point.dev').onUserGesture(),
        const MapFollowState.idle(),
      );
    });

    test('map interpolation crosses the antimeridian on the short path', () {
      final tween = MapLatLngTween(
        begin: const LatLng(0, 179),
        end: const LatLng(0, -179),
      );

      expect(tween.lerp(0.5).longitude, closeTo(-180, 0.000001));
      expect(tween.lerp(1).longitude, closeTo(-179, 0.000001));
    });
  });

  group('ShareRequest.fromJson', () {
    test('reads from_display_name (server field)', () {
      final r = ShareRequest.fromJson(const {
        'id': 'r1',
        'from_user_id': 'devon@point.dev',
        'from_display_name': 'Devon R',
      });
      expect(r.fromDisplayName, 'Devon R');
      expect(r.fromHandle, 'devon');
    });

    test('falls back to handle when no name', () {
      final r = ShareRequest.fromJson(const {
        'id': 'r1',
        'from_user_id': 'devon@point.dev',
      });
      expect(r.fromDisplayName, 'devon');
    });
  });
}
