import 'package:flutter_test/flutter_test.dart';
import 'package:point_app/features/people/presentation/person_detail_screen.dart';

/// Layer-4 viewer-side adaptive cadence (location-strategy: 15s moving / 45s
/// recent / 2min stale).
void main() {
  final now = DateTime.fromMillisecondsSinceEpoch(1752357600000);
  int ago(Duration d) => now.millisecondsSinceEpoch - d.inMilliseconds;

  test('fresh / moving position nudges every 15s', () {
    expect(
      watchNudgeCadence(ago(const Duration(seconds: 5)), now: now),
      const Duration(seconds: 15),
    );
  });

  test('recently moved position eases to 45s', () {
    expect(
      watchNudgeCadence(ago(const Duration(seconds: 90)), now: now),
      const Duration(seconds: 45),
    );
  });

  test('stale position slows to 2min', () {
    expect(
      watchNudgeCadence(ago(const Duration(minutes: 10)), now: now),
      const Duration(minutes: 2),
    );
  });

  test('missing position eases to the middle rate', () {
    expect(watchNudgeCadence(null, now: now), const Duration(seconds: 45));
  });
}
