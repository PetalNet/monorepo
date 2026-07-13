import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:point_app/features/people/invite.dart';
import 'package:point_app/features/people/presentation/add_person_screen.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/api/point_api.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/theme/app_theme.dart';

class _SignedInAuth extends AuthController {
  @override
  Future<Session?> build() async => const Session(
    token: 'token',
    userId: 'eli@point.dev',
    displayName: 'Eli',
    isAdmin: false,
  );
}

void main() {
  group('invite link round-trip', () {
    test('generates stable HTTPS and preserves a self-hosted handle', () {
      final link = inviteLinkFor('parker@point.petalcat.dev');
      expect(
        link,
        'https://point.petalcat.dev/add/parker@point.petalcat.dev',
      );
      expect(
        handleFromInvite(Uri.parse(link)),
        'parker@point.petalcat.dev',
      );
      expect(
        handleFromInvite(
          Uri.parse(inviteLinkFor('eli@self-hosted.example')),
        ),
        'eli@self-hosted.example',
      );
    });

    test('accepts legacy custom-scheme links', () {
      expect(
        handleFromInvite(Uri.parse('point://add/eli%40x.dev')),
        'eli@x.dev',
      );
    });

    test('rejects non-invite URIs', () {
      expect(handleFromInvite(Uri.parse('point://ghost')), isNull);
      expect(
        handleFromInvite(Uri.parse('https://point.petalcat.dev/')),
        isNull,
      );
      expect(
        handleFromInvite(Uri.parse('https://evil.example/add/eli%40x.dev')),
        isNull,
      );
      expect(
        handleFromInvite(
          Uri.parse('http://point.petalcat.dev/add/eli%40x.dev'),
        ),
        isNull,
      );
      expect(
        handleFromInvite(
          Uri.parse('https://point.petalcat.dev/add/not-a-handle'),
        ),
        isNull,
      );
    });
  });

  group('fallback invite code', () {
    test('round-trips a full federated handle without server lookup', () {
      final code = inviteCodeFor('Mara@Fieldstone.Social');
      expect(code, startsWith('P1-'));
      expect(handleFromInviteCode(code), 'mara@fieldstone.social');
      expect(
        normalizeHandle(code.toLowerCase(), selfDomain: 'unused.example'),
        'mara@fieldstone.social',
      );
      expect(
        normalizeHandle(
          code.replaceAll('-', '').toLowerCase(),
          selfDomain: 'unused.example',
        ),
        'mara@fieldstone.social',
      );
    });

    test('malformed compact code is rejected, not treated as a username', () {
      final compact = inviteCodeFor(
        'eli@self-hosted.example',
      ).replaceAll('-', '');
      final replacement = compact.endsWith('0') ? '1' : '0';
      final mistyped =
          '${compact.substring(0, compact.length - 1)}$replacement';
      expect(
        normalizeHandle(mistyped, selfDomain: 'point.dev'),
        isEmpty,
      );
    });

    test('checksum rejects a mistyped code', () {
      final code = inviteCodeFor('eli@self-hosted.example');
      final replacement = code.endsWith('0') ? '1' : '0';
      final mistyped = '${code.substring(0, code.length - 1)}$replacement';
      expect(handleFromInviteCode(mistyped), isNull);
      expect(
        normalizeHandle(mistyped, selfDomain: 'point.dev'),
        isEmpty,
      );
    });

    test('share copy includes both resilient paths', () {
      final text = inviteShareTextFor('eli@self-hosted.example');
      expect(text, contains(inviteLinkFor('eli@self-hosted.example')));
      expect(text, contains(inviteCodeFor('eli@self-hosted.example')));
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

  test(
    'request API decodes lifecycle timestamps and cancels with DELETE',
    () async {
      final calls = <http.Request>[];
      final api = PointApi(
        baseUrl: 'https://point.dev',
        client: MockClient((request) async {
          calls.add(request);
          if (request.method == 'GET') {
            return http.Response(
              '[{"id":"r1","to_user_id":"mara@point.dev",'
              '"to_display_name":"Mara","created_at":"2026-07-13T15:30:00Z"}]',
              200,
            );
          }
          return http.Response('{"ok":true}', 200);
        }),
      );

      final requests = await api.outgoingRequests('token');
      expect(requests.single.createdAt, DateTime.utc(2026, 7, 13, 15, 30));

      await api.cancelRequest('token', 'r1');
      expect(calls.last.method, 'DELETE');
      expect(calls.last.url.path, '/api/shares/requests/r1');
      expect(calls.last.headers['authorization'], 'Bearer token');
    },
  );

  testWidgets('sending transitions to a persistent requested state', (
    tester,
  ) async {
    var sends = 0;
    final api = PointApi(
      baseUrl: 'https://point.dev',
      client: MockClient((request) async {
        if (request.method == 'POST') {
          sends++;
          return http.Response('{"ok":true,"recorded":true}', 200);
        }
        return http.Response(
          '[{"id":"r1","to_user_id":"mara@point.dev",'
          '"to_display_name":"Mara","created_at":"2026-07-13T15:30:00Z"}]',
          200,
        );
      }),
    );

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          authControllerProvider.overrideWith(_SignedInAuth.new),
          apiProvider.overrideWithValue(api),
        ],
        child: MaterialApp(
          theme: AppTheme.dark(pureBlack: true),
          home: const AddPersonScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), 'mara');
    await tester.tap(find.text('Send request'));
    await tester.pumpAndSettle();

    expect(sends, 1);
    expect(find.text('Requested'), findsOneWidget);
    expect(find.text('Pending'), findsOneWidget);
    expect(find.text('mara@point.dev'), findsOneWidget);
    expect(find.text('Send request'), findsNothing);
  });

  group('native share state', () {
    Widget host(InviteShareCallback onShare) => MaterialApp(
      theme: AppTheme.dark(pureBlack: true),
      home: Scaffold(
        body: SingleChildScrollView(
          child: InviteCard(
            userId: 'eli@self-hosted.example',
            onShare: onShare,
          ),
        ),
      ),
    );

    testWidgets('disables duplicate shares until the sheet returns', (
      tester,
    ) async {
      final pending = Completer<void>();
      String? sharedText;
      Rect? sharedOrigin;
      await tester.pumpWidget(
        host((text, origin) {
          sharedText = text;
          sharedOrigin = origin;
          return pending.future;
        }),
      );

      await tester.tap(find.text('Share invite'));
      await tester.pump();

      expect(find.text('Sharing…'), findsOneWidget);
      expect(
        tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
        isNull,
      );
      expect(sharedText, inviteShareTextFor('eli@self-hosted.example'));
      expect(sharedOrigin, isNotNull);
      expect(sharedOrigin!.size, isNot(Size.zero));

      pending.complete();
      await tester.pump();
      expect(find.text('Share invite'), findsOneWidget);
      expect(
        tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
        isNotNull,
      );
    });

    testWidgets('recovers and explains when the native sheet fails', (
      tester,
    ) async {
      await tester.pumpWidget(
        host((_, _) async => throw StateError('platform unavailable')),
      );

      await tester.tap(find.text('Share invite'));
      await tester.pump();

      expect(find.text('Could not open the share sheet.'), findsOneWidget);
      expect(find.text('Share invite'), findsOneWidget);
      expect(
        tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
        isNotNull,
      );
    });
  });
}
