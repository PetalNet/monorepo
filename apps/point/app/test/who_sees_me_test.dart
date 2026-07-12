import 'package:flutter_test/flutter_test.dart';
import 'package:point_app/features/ghost/who_sees_me.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/theme/presence_tokens.dart';

Person _p(String id) =>
    Person(userId: id, displayName: id, presence: PresenceState.away);

void main() {
  final people = [_p('eli@x'), _p('mara@y'), _p('devon@z')];

  test('globally dark → visible to nobody', () {
    final w = WhoSeesMe(
      dark: true,
      people: people,
      ghost: const GhostState(active: true),
    );
    expect(w.visibleCount, 0);
    expect(w.isVisibleTo(people.first), isFalse);
  });

  test('not dark → visible to everyone not individually hidden', () {
    final w = WhoSeesMe(
      dark: false,
      people: people,
      ghost: const GhostState(active: false, hiddenFrom: {'mara@y'}),
    );
    expect(w.visibleCount, 2);
    expect(w.isVisibleTo(_p('eli@x')), isTrue);
    expect(w.isVisibleTo(_p('mara@y')), isFalse);
  });

  test('no shares → zero', () {
    const w = WhoSeesMe(
      dark: false,
      people: [],
      ghost: GhostState(active: false),
    );
    expect(w.visibleCount, 0);
  });
}
