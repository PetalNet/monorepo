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

    test('with fix → live, located, "Sharing · Nm"', () {
      final fix = PeerFix(userId: 'eli@point.dev', data: {
        'lat': 38.6,
        'lon': -90.2,
        'timestamp': ago(const Duration(minutes: 5)),
      });
      final merged = mergePresence(away, fix, now: now);
      expect(merged.presence, PresenceState.live);
      expect(merged.hasLocation, isTrue);
      expect(merged.lat, 38.6);
      expect(merged.subtitle, 'Sharing · 5m');
    });

    test('fix without coordinates → unchanged', () {
      const fix = PeerFix(userId: 'eli@point.dev', data: {'speed': 1});
      expect(mergePresence(away, fix).hasLocation, isFalse);
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
