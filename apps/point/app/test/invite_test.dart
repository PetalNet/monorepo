import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:point_app/features/people/invite.dart';
import 'package:point_app/services/api/point_api.dart';

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
        handleFromInvite(
          Uri.parse('https://point.petalcat.dev/add/eli%40x.dev'),
        ),
        'eli@x.dev',
      );
    });

    test('rejects non-invite URIs', () {
      expect(handleFromInvite(Uri.parse('point://ghost')), isNull);
      expect(
        handleFromInvite(Uri.parse('https://point.petalcat.dev/')),
        isNull,
      );
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

    // Task 727: an already-qualified-but-foreign shape must NEVER get the
    // home domain appended (janet:server@server resolved to nobody while the
    // toast claimed "Request sent"). Malformed input → '' → caller errors.
    test('colon-qualified handle → invalid, never double-qualified (727)', () {
      expect(
        normalizeHandle('janet:point.petalcat.dev', selfDomain: 'point.dev'),
        '',
      );
    });

    test('multiple @ / empty parts / spaces → invalid', () {
      expect(normalizeHandle('a@b@c', selfDomain: 'point.dev'), '');
      expect(normalizeHandle('@point.dev', selfDomain: 'point.dev'), '');
      expect(normalizeHandle('janet@', selfDomain: 'point.dev'), '');
      expect(normalizeHandle('ja net', selfDomain: 'point.dev'), '');
      expect(normalizeHandle('janet@point dev', selfDomain: 'point.dev'), '');
    });

    test('valid shapes still pass untouched', () {
      expect(
        normalizeHandle('  Janet@Point.Petalcat.Dev ', selfDomain: 'x.dev'),
        'janet@point.petalcat.dev',
      );
      expect(
        normalizeHandle('janet', selfDomain: 'point.petalcat.dev'),
        'janet@point.petalcat.dev',
      );
    });
  });

  test(
    'non-resolving canonical handle errors instead of false success (727)',
    () async {
      final api = PointApi(
        baseUrl: 'https://point.dev',
        client: MockClient(
          (_) async => http.Response(
            '{"ok":true,"recorded":false}',
            200,
            headers: {'content-type': 'application/json'},
          ),
        ),
      );

      await expectLater(
        api.sendShareRequest('token', 'nobody@point.dev'),
        throwsA(
          isA<ApiException>().having(
            (e) => e.message,
            'message',
            contains('could not be found'),
          ),
        ),
      );
    },
  );
}
