import 'package:flutter_test/flutter_test.dart';
import 'package:point_app/features/people/people_controller.dart';
import 'package:point_app/features/relay/relay_controller.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/theme/presence_tokens.dart';

void main() {
  test(
    'share.removed drops People, Map fix, and outbound relay target (728)',
    () {
      const peer = 'bob@point.dev';
      const person = Person(
        userId: peer,
        displayName: 'Bob',
        presence: PresenceState.live,
      );
      const fix = PeerFix(userId: peer, data: {'lat': 1.0, 'lon': 2.0});
      final targets = <String>{peer};
      final rekeys = <String, DateTime>{peer: DateTime.utc(2026)};
      final shares = <String, DateTime>{peer: DateTime.utc(2026, 2)};

      removeRelayTarget(
        peer,
        targets: targets,
        peerRekeyedAt: rekeys,
        shareSince: shares,
      );

      expect(withoutSharedPerson(const [person], peer), isEmpty);
      expect(withoutPeerFix(const {peer: fix}, peer), isEmpty);
      expect(targets, isEmpty, reason: 'no more location encryption/pushes');
      expect(rekeys, isEmpty);
      expect(shares, isEmpty);
    },
  );
}
