import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/people/presentation/temp_share_sheet.dart';
import 'package:point_app/features/people/temp_shares_controller.dart';
import 'package:point_app/features/relay/relay_controller.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/theme/app_theme.dart';
import 'package:point_app/theme/presence_tokens.dart';

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

  test('incoming and outgoing temporary relationships stay separate', () {
    final rows = [
      mk('me@point.dev', 'friend@point.dev', const Duration(hours: 1)),
      mk('walker@remote.dev', 'me@point.dev', const Duration(minutes: 15)),
      mk('stale@remote.dev', 'me@point.dev', const Duration(minutes: -1)),
    ];

    expect(myOutgoingTemps(rows, 'me@point.dev', now).keys, [
      'friend@point.dev',
    ]);
    expect(myIncomingTemps(rows, 'me@point.dev', now).keys, [
      'walker@remote.dev',
    ]);
  });

  test('incoming temp identities exclude existing ongoing people', () {
    final incoming = {
      'mara@point.dev': mk(
        'mara@point.dev',
        'me@point.dev',
        const Duration(hours: 1),
      ),
      'walker@remote.dev': mk(
        'walker@remote.dev',
        'me@point.dev',
        const Duration(hours: 1),
      ),
    };
    const ongoing = [
      Person(
        userId: 'mara@point.dev',
        displayName: 'Mara',
        presence: PresenceState.live,
      ),
    ];

    final identities = tempOnlySenderIdentities(incoming, ongoing);

    expect(identities, hasLength(1));
    expect(identities.single.userId, 'walker@remote.dev');
    expect(identities.single.displayName, 'walker');
    expect(identities.single.subtitle, 'walker@remote.dev');
  });

  test('incoming temp-only sender resolves a decrypted recipient location', () {
    final incoming = {
      'walker@remote.dev': mk(
        'walker@remote.dev',
        'me@point.dev',
        const Duration(hours: 1),
      ),
    };
    final people = resolveIncomingTempPeople(
      incoming: incoming,
      ongoing: const [],
      fixes: {
        'walker@remote.dev': PeerFix(
          userId: 'walker@remote.dev',
          data: {
            'lat': 41.8781,
            'lon': -87.6298,
            'timestamp': now.millisecondsSinceEpoch,
          },
        ),
      },
      serverPresence: const {},
      now: now,
      selfDomain: 'point.dev',
    );

    expect(people, hasLength(1));
    expect(people.single.userId, 'walker@remote.dev');
    expect(people.single.hasLocation, isTrue);
    expect(people.single.lat, 41.8781);
    expect(people.single.lon, -87.6298);
    expect(people.single.subtitle, 'walker@remote.dev · now');
  });

  test('computeShareTargets unions ongoing shares and temp targets', () {
    expect(computeShareTargets(['a@x', 'b@x'], ['b@x', 'temp@x']).toSet(), {
      'a@x',
      'b@x',
      'temp@x',
    });
  });

  test('temp teardown drops a peer fix when viewing access ended', () {
    final remaining = [
      mk('me@point.dev', 'walker@remote.dev', const Duration(hours: 1)),
    ];

    expect(
      retainsPeerLocationAfterTempTeardown(
        remaining: remaining,
        me: 'me@point.dev',
        peer: 'walker@remote.dev',
        permanentPeers: const [],
        now: now,
      ),
      isFalse,
      reason: 'an outgoing temp never grants access to the recipient fix',
    );
  });

  test(
    'temp teardown retains a peer fix only for another active access path',
    () {
      final anotherIncoming = [
        mk('walker@remote.dev', 'me@point.dev', const Duration(minutes: 5)),
      ];

      expect(
        retainsPeerLocationAfterTempTeardown(
          remaining: anotherIncoming,
          me: 'me@point.dev',
          peer: 'walker@remote.dev',
          permanentPeers: const [],
          now: now,
        ),
        isTrue,
      );
      expect(
        retainsPeerLocationAfterTempTeardown(
          remaining: const [],
          me: 'me@point.dev',
          peer: 'walker@remote.dev',
          permanentPeers: const ['walker@remote.dev'],
          now: now,
        ),
        isTrue,
      );
      expect(
        retainsPeerLocationAfterTempTeardown(
          remaining: [
            mk(
              'walker@remote.dev',
              'me@point.dev',
              const Duration(seconds: -1),
            ),
          ],
          me: 'me@point.dev',
          peer: 'walker@remote.dev',
          permanentPeers: const [],
          now: now,
        ),
        isFalse,
        reason: 'an expired parallel temp is not an access path',
      );
    },
  );

  test('expiry clock evicts only the last temp-only peer access', () {
    final walker = mk(
      'walker@remote.dev',
      'me@point.dev',
      const Duration(minutes: 1),
    );
    final mara = mk(
      'mara@point.dev',
      'me@point.dev',
      const Duration(minutes: 1),
    );

    expect(
      peersLosingTempLocationAccess(
        previous: {'walker@remote.dev': walker, 'mara@point.dev': mara},
        next: const {},
        permanentPeers: const ['mara@point.dev'],
      ),
      {'walker@remote.dev'},
    );
    expect(
      peersLosingTempLocationAccess(
        previous: null,
        next: const {},
        permanentPeers: const [],
      ),
      isEmpty,
      reason: 'initial loading is not proof that access was revoked',
    );
  });

  testWidgets('exact handle advances to an unmistakable one-way share', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [authControllerProvider.overrideWith(_SignedInAuth.new)],
        child: MaterialApp(
          theme: AppTheme.dark(pureBlack: true),
          home: const Scaffold(body: TempShareSheet()),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Share temporarily'), findsOneWidget);
    expect(find.text("They see you. You don't see them."), findsOneWidget);

    await tester.enterText(find.byType(TextField), 'walker@remote.dev');
    await tester.pump();
    await tester.ensureVisible(find.text('Continue'));
    await tester.tap(find.text('Continue'));
    await tester.pump();

    expect(find.text('Share with walker for a while'), findsOneWidget);
    expect(
      find.text("walker sees your live location. You won't see them."),
      findsOneWidget,
    );
    expect(find.text('1 hour'), findsOneWidget);
  });
}
