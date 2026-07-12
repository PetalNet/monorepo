import 'package:flutter_test/flutter_test.dart';
import 'package:point_app/features/people/temp_shares_controller.dart';
import 'package:point_app/services/api/models.dart';

void main() {
  final now = DateTime(2026, 7, 12, 12);
  TempShare mk(String from, String to, Duration fromNow) => TempShare(
        id: '$from>$to',
        fromUserId: from,
        toUserId: to,
        expiresAt: now.add(fromNow),
      );

  test('TempShare.fromJson parses direction + expiry', () {
    final t = TempShare.fromJson(const {
      'id': 't1',
      'from_user_id': 'me@point.dev',
      'to_user_id': 'friend@point.dev',
      'expires_at': '2030-01-01T00:00:00Z',
    });
    expect(t.fromUserId, 'me@point.dev');
    expect(t.toUserId, 'friend@point.dev');
    expect(t.expiresAt.isUtc, isTrue);
  });

  test('myOutgoingTemps keeps only my unexpired outgoing temps', () {
    final rows = [
      mk('me@point.dev', 'friend@point.dev', const Duration(hours: 1)),
      mk('me@point.dev', 'stale@point.dev', const Duration(minutes: -1)),
      mk('other@point.dev', 'me@point.dev', const Duration(hours: 1)),
    ];
    final out = myOutgoingTemps(rows, 'me@point.dev', now);
    expect(out.keys, ['friend@point.dev']);
  });

  test('myOutgoingTemps → empty when signed out', () {
    final rows = [mk('me@point.dev', 'x@point.dev', const Duration(hours: 1))];
    expect(myOutgoingTemps(rows, null, now), isEmpty);
  });

  test('computeShareTargets unions ongoing shares and temp targets', () {
    expect(
      computeShareTargets(['a@x', 'b@x'], ['b@x', 'temp@x']).toSet(),
      {'a@x', 'b@x', 'temp@x'},
    );
  });
}
