import 'package:flutter_test/flutter_test.dart';
import 'package:point_app/features/people/invite.dart';

void main() {
  group('invite link round-trip', () {
    test('link encodes the user id and parses back', () {
      final link = inviteLinkFor('parker@point.petalcat.dev');
      expect(link, 'point://add/parker%40point.petalcat.dev');
      expect(
        handleFromInvite(Uri.parse(link)),
        'parker@point.petalcat.dev',
      );
    });

    test('accepts an https add link', () {
      expect(
        handleFromInvite(Uri.parse('https://point.petalcat.dev/add/eli%40x.dev')),
        'eli@x.dev',
      );
    });

    test('rejects non-invite URIs', () {
      expect(handleFromInvite(Uri.parse('point://ghost')), isNull);
      expect(handleFromInvite(Uri.parse('https://point.petalcat.dev/')), isNull);
      expect(handleFromInvite(Uri.parse('https://evil.example/add/x')), 'x');
    });
  });

  group('normalizeHandle', () {
    test('bare username → appends own server (same-server add)', () {
      expect(normalizeHandle('Eli', selfDomain: 'point.dev'), 'eli@point.dev');
    });

    test('full handle → used as-is, lowercased (cross-server)', () {
      expect(
        normalizeHandle('Mara@Fieldstone.Social', selfDomain: 'point.dev'),
        'mara@fieldstone.social',
      );
    });

    test('empty → empty', () {
      expect(normalizeHandle('   ', selfDomain: 'point.dev'), '');
    });
  });
}
