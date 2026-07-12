import 'package:flutter_test/flutter_test.dart';
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
      final fix = PeerFix(userId: 'eli@point.dev', data: {
        'lat': 38.6,
        'lon': -90.2,
        'timestamp': ago(const Duration(minutes: 1)),
      });
      final merged = mergePresence(away, fix, now: now);
      expect(merged.presence, PresenceState.live);
      expect(merged.hasLocation, isTrue);
      expect(merged.lat, 38.6);
      expect(merged.subtitle, 'Sharing · 1m');
    });

    test('stale fix (> darkAfter) → DARK: frozen last-known + "Dark since"', () {
      final darkTs = ago(const Duration(minutes: 20));
      final fix = PeerFix(userId: 'eli@point.dev', data: {
        'lat': 38.6,
        'lon': -90.2,
        'timestamp': darkTs,
      });
      final merged = mergePresence(away, fix, now: now);
      expect(merged.presence, PresenceState.stale);
      // Frozen last-known coordinate is retained (shown in People/detail).
      expect(merged.hasLocation, isTrue);
      expect(merged.subtitle, startsWith('Dark since '));
      expect(merged.subtitle, 'Dark since ${clockHm(darkTs)}');
    });

    test('fix without coordinates → unchanged', () {
      const fix = PeerFix(userId: 'eli@point.dev', data: {'speed': 1});
      expect(mergePresence(away, fix).hasLocation, isFalse);
    });

    test('same-server live person → plain status (no @server)', () {
      final fix = PeerFix(userId: 'eli@point.dev', data: {
        'lat': 1.0,
        'lon': 2.0,
        'timestamp': ago(const Duration(minutes: 3)),
      });
      final merged = mergePresence(away, fix, selfDomain: 'point.dev', now: now);
      expect(merged.subtitle, 'Sharing · 3m');
    });

    test('cross-server live person → @server shown quiet in status', () {
      const mara = Person(
        userId: 'mara@fieldstone.social',
        displayName: 'Mara',
        presence: PresenceState.away,
      );
      final fix = PeerFix(userId: 'mara@fieldstone.social', data: {
        'lat': 1.0,
        'lon': 2.0,
        'timestamp': ago(const Duration(minutes: 3)),
      });
      final merged = mergePresence(mara, fix, selfDomain: 'point.dev', now: now);
      expect(merged.subtitle, 'mara@fieldstone.social · 3m');
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
