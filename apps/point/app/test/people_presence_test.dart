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

    test('fresh fix → live, located, "Sharing · Nm"', () {
      final fix = PeerFix(
        userId: 'eli@point.dev',
        data: {
          'lat': 38.6,
          'lon': -90.2,
          'timestamp': ago(const Duration(minutes: 1)),
        },
      );
      final merged = mergePresence(away, fix, now: now);
      expect(merged.presence, PresenceState.live);
      expect(merged.hasLocation, isTrue);
      expect(merged.lat, 38.6);
      expect(merged.subtitle, 'Sharing · 1m');
    });

    test(
      'stale fix (> darkAfter) → DARK: frozen last-known + "Dark since"',
      () {
        final darkTs = ago(const Duration(minutes: 20));
        final fix = PeerFix(
          userId: 'eli@point.dev',
          data: {
            'lat': 38.6,
            'lon': -90.2,
            'timestamp': darkTs,
          },
        );
        final merged = mergePresence(away, fix, now: now);
        expect(merged.presence, PresenceState.stale);
        // Frozen last-known coordinate is retained (shown in People/detail).
        expect(merged.hasLocation, isTrue);
        expect(merged.subtitle, startsWith('Dark since '));
        expect(merged.subtitle, 'Dark since ${clockHm(darkTs)}');
      },
    );

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

        final motion = PeerMarkerMotion.initial(first).advance(
          second,
          now: second.receivedAt,
        );

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

      final motion = PeerMarkerMotion.initial(first).advance(
        stale,
        now: stale.receivedAt!.add(const Duration(minutes: 4)),
      );

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

        final motion = PeerMarkerMotion.initial(first).advance(
          resumed,
          now: resumed.receivedAt,
        );

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

      final motion = PeerMarkerMotion.initial(first).advance(
        impossible,
        now: impossible.receivedAt,
      );

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
