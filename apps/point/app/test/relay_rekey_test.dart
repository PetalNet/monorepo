import 'package:flutter_test/flutter_test.dart';
import 'package:point_app/features/relay/relay_controller.dart';

void main() {
  group('task 726 pairwise rekey decision', () {
    final generation = DateTime.utc(2026, 7, 13, 2);

    test('initiator replaces an existing group for a new peer generation', () {
      expect(
        shouldInitiatePairwiseGroup(
          selfUserId: 'alice@point.dev',
          peerUserId: 'bob@point.dev',
          hasGroup: true,
          peerRekeyedAt: generation,
          selfRekeyedAt: generation.subtract(const Duration(minutes: 1)),
          shareSince: generation.subtract(const Duration(hours: 1)),
          handledPeerRekeyedAt: generation.subtract(const Duration(seconds: 1)),
          handledShareSince: generation.subtract(const Duration(hours: 1)),
        ),
        isTrue,
      );
    });

    test(
      'handled generation does not consume another KeyPackage on restart',
      () {
        expect(
          shouldInitiatePairwiseGroup(
            selfUserId: 'alice@point.dev',
            peerUserId: 'bob@point.dev',
            hasGroup: true,
            peerRekeyedAt: generation,
            selfRekeyedAt: generation.subtract(const Duration(minutes: 1)),
            shareSince: generation.subtract(const Duration(hours: 1)),
            handledPeerRekeyedAt: generation,
            handledShareSince: generation.subtract(const Duration(hours: 1)),
          ),
          isFalse,
        );
      },
    );

    test('only deterministic initiator rebuilds a mutual group', () {
      expect(
        shouldInitiatePairwiseGroup(
          selfUserId: 'bob@point.dev',
          peerUserId: 'alice@point.dev',
          hasGroup: true,
          peerRekeyedAt: generation,
          selfRekeyedAt: generation,
          shareSince: generation,
          handledPeerRekeyedAt: null,
          handledShareSince: null,
        ),
        isFalse,
      );
    });

    test('older peer initiates toward newly registered identity', () {
      expect(
        shouldInitiatePairwiseGroup(
          selfUserId: 'petalcat@point.dev',
          peerUserId: 'janet@point.dev',
          hasGroup: true,
          selfRekeyedAt: generation,
          peerRekeyedAt: generation.add(const Duration(minutes: 1)),
          shareSince: generation,
          handledPeerRekeyedAt: generation,
          handledShareSince: generation,
        ),
        isTrue,
        reason: "petalcat must consume Janet's fresh package",
      );
    });

    test('newly registered identity waits for its older peer Welcome', () {
      expect(
        shouldInitiatePairwiseGroup(
          selfUserId: 'janet@point.dev',
          peerUserId: 'petalcat@point.dev',
          hasGroup: false,
          selfRekeyedAt: generation.add(const Duration(minutes: 1)),
          peerRekeyedAt: generation,
          shareSince: generation,
          handledPeerRekeyedAt: null,
          handledShareSince: null,
        ),
        isFalse,
      );
    });

    test(
      'remove and re-pair advances share epoch and replaces stale group',
      () {
        expect(
          shouldInitiatePairwiseGroup(
            selfUserId: 'alice@point.dev',
            peerUserId: 'bob@point.dev',
            hasGroup: true,
            selfRekeyedAt: generation,
            peerRekeyedAt: generation,
            shareSince: generation.add(const Duration(minutes: 5)),
            handledPeerRekeyedAt: generation,
            handledShareSince: generation,
          ),
          isTrue,
        );
      },
    );
  });
}
