import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:point_app/app/shell_chrome.dart';
import 'package:point_app/features/ghost/who_sees_me.dart';
import 'package:point_app/features/people/presentation/people_screen.dart';
import 'package:point_app/features/people/requests_controller.dart';
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

class _MutableRequests extends RequestsController {
  @override
  Future<List<ShareRequest>> build() async => const [
    ShareRequest(
      id: 'r1',
      fromUserId: 'mara@point.dev',
      fromDisplayName: 'Mara',
    ),
    ShareRequest(
      id: 'r2',
      fromUserId: 'parker@point.dev',
      fromDisplayName: 'Parker',
    ),
  ];

  void clear() => state = const AsyncData([]);
}

void main() {
  testWidgets('People navigation badge follows the live incoming count', (
    tester,
  ) async {
    final container = ProviderContainer(
      overrides: [
        requestsControllerProvider.overrideWith(_MutableRequests.new),
        whoSeesMeProvider.overrideWithValue(
          const WhoSeesMe(
            dark: true,
            people: [],
            ghost: GhostState(active: true),
          ),
        ),
      ],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: AppTheme.dark(pureBlack: true),
          home: ShellChrome(
            activeBranch: 0,
            branchContent: const SizedBox(),
            onSwitch: (_) {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('2'), findsWidgets);

    (container.read(requestsControllerProvider.notifier) as _MutableRequests)
        .clear();
    await tester.pump();

    expect(find.text('2'), findsNothing);
  });

  testWidgets('sent request cancellation is optimistic and reconciles', (
    tester,
  ) async {
    var cancelled = false;
    final api = PointApi(
      baseUrl: 'https://point.dev',
      client: MockClient((request) async {
        if (request.method == 'DELETE') {
          cancelled = true;
          return http.Response('{"ok":true}', 200);
        }
        if (request.url.path.endsWith('/outgoing')) {
          return http.Response(
            cancelled
                ? '[]'
                : '[{"id":"r1","to_user_id":"mara@point.dev",'
                      '"to_display_name":"Mara",'
                      '"created_at":"2026-07-13T15:30:00Z"}]',
            200,
          );
        }
        return http.Response('[]', 200);
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
          home: const RequestsScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Mara'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();

    expect(cancelled, isTrue);
    expect(find.text('Mara'), findsNothing);
    expect(find.text('No sent requests are pending.'), findsOneWidget);
  });

  testWidgets('committed cancellation stays successful if refresh fails', (
    tester,
  ) async {
    var cancelled = false;
    final api = PointApi(
      baseUrl: 'https://point.dev',
      client: MockClient((request) async {
        if (request.method == 'DELETE') {
          cancelled = true;
          return http.Response('{"ok":true}', 200);
        }
        if (request.url.path.endsWith('/outgoing')) {
          if (cancelled) throw StateError('refresh unavailable');
          return http.Response(
            '[{"id":"r1","to_user_id":"mara@point.dev",'
            '"to_display_name":"Mara",'
            '"created_at":"2026-07-13T15:30:00Z"}]',
            200,
          );
        }
        return http.Response('[]', 200);
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
          home: const RequestsScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Cancel'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(cancelled, isTrue);
    expect(find.textContaining('Cancelled'), findsWidgets);
    expect(find.textContaining('Could not cancel. Try again.'), findsNothing);
    expect(find.text('Cancel'), findsNothing);
  });
}
