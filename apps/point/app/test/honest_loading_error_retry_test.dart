import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:point_app/features/map/map_tiles.dart';
import 'package:point_app/features/map/presentation/map_screen.dart';
import 'package:point_app/features/me/avatar_provider.dart';
import 'package:point_app/features/people/people_controller.dart';
import 'package:point_app/features/people/people_presence.dart';
import 'package:point_app/features/people/presentation/people_screen.dart';
import 'package:point_app/features/people/requests_controller.dart';
import 'package:point_app/features/people/temp_shares_controller.dart';
import 'package:point_app/features/relay/data/realtime_sync_coordinator.dart';
import 'package:point_app/features/relay/domain/realtime_sync_models.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/api/point_api.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/theme/app_theme.dart';
import 'package:point_app/theme/presence_tokens.dart';

const _mara = Person(
  userId: 'mara@point.dev',
  displayName: 'Mara',
  presence: PresenceState.away,
);

Duration? _noRetry(int _, Object _) => null;

class _RefreshablePeople extends PeopleController {
  bool shouldFail = false;
  List<Person> result = const [_mara];

  @override
  Future<List<Person>> build() async {
    if (shouldFail) throw StateError('server unavailable');
    return result;
  }
}

class _PendingPeople extends PeopleController {
  static Completer<List<Person>> pending = Completer<List<Person>>();

  @override
  Future<List<Person>> build() => pending.future;
}

class _EmptyRequests extends RequestsController {
  @override
  Future<List<ShareRequest>> build() async => const [];
}

class _EmptyOutgoing extends OutgoingRequestsController {
  @override
  Future<List<OutgoingShareRequest>> build() async => const [];
}

class _FailingOutgoing extends OutgoingRequestsController {
  @override
  Future<List<OutgoingShareRequest>> build() async =>
      throw StateError('requests unavailable');
}

class _SignedInAuth extends AuthController {
  @override
  Future<Session?> build() async => const Session(
    token: 'token',
    userId: 'eli@point.dev',
    displayName: 'Eli',
    isAdmin: false,
  );
}

class _RecordingSync implements RealtimeSyncCoordinator {
  int calls = 0;

  @override
  Stream<RealtimeSyncDiff> get diffs => const Stream.empty();

  @override
  Future<void> dispose() async {}

  @override
  Future<RealtimeSyncDiff> syncNow(RealtimeSyncReason reason) async {
    calls++;
    return RealtimeSyncDiff(
      reason: reason,
      mailbox: const MailboxDrainDiff(),
    );
  }
}

void main() {
  test('failed refresh retains last-good people and recovers', () async {
    final container = ProviderContainer(
      retry: _noRetry,
      overrides: [
        peopleControllerProvider.overrideWith(_RefreshablePeople.new),
      ],
    );
    addTearDown(container.dispose);

    await container.read(peopleControllerProvider.future);
    final notifier =
        container.read(peopleControllerProvider.notifier) as _RefreshablePeople;

    final failedRefresh = (notifier..shouldFail = true).refresh();
    await expectLater(failedRefresh, throwsStateError);

    final failed = container.read(peopleControllerProvider);
    expect(failed.hasError, isTrue);
    expect(failed.hasValue, isTrue);
    expect(failed.value, const [_mara]);

    notifier
      ..shouldFail = false
      ..result = const [];
    await notifier.refresh();

    final recovered = container.read(peopleControllerProvider);
    expect(recovered.hasError, isFalse);
    expect(recovered.value, isEmpty);
  });

  testWidgets('initial People loading becomes an honest error with Retry', (
    tester,
  ) async {
    _PendingPeople.pending = Completer<List<Person>>();
    final sync = _RecordingSync();

    await tester.pumpWidget(
      ProviderScope(
        retry: _noRetry,
        overrides: [
          peopleControllerProvider.overrideWith(_PendingPeople.new),
          peopleWithPresenceProvider.overrideWithValue(const []),
          requestsControllerProvider.overrideWith(_EmptyRequests.new),
          outgoingRequestsControllerProvider.overrideWith(_EmptyOutgoing.new),
          outgoingTempsProvider.overrideWithValue(const {}),
          realtimeSyncCoordinatorProvider.overrideWithValue(sync),
        ],
        child: MaterialApp(
          theme: AppTheme.dark(pureBlack: true),
          home: const PeopleScreen(),
        ),
      ),
    );
    await tester.pump();

    expect(find.byKey(const ValueKey('people-loading')), findsOneWidget);
    expect(find.text('No one yet.'), findsNothing);

    _PendingPeople.pending.completeError(StateError('offline'));
    await tester.pump();
    await tester.pump();

    expect(find.byKey(const ValueKey('people-unavailable')), findsOneWidget);
    expect(find.text('People unavailable'), findsOneWidget);
    expect(find.text('No one yet.'), findsNothing);

    await tester.tap(find.text('Retry'));
    await tester.pump();
    expect(sync.calls, 1);
  });

  testWidgets('request failure keeps successfully loaded people visible', (
    tester,
  ) async {
    final sync = _RecordingSync();

    await tester.pumpWidget(
      ProviderScope(
        retry: _noRetry,
        overrides: [
          peopleControllerProvider.overrideWith(_RefreshablePeople.new),
          peopleWithPresenceProvider.overrideWithValue(const [_mara]),
          requestsControllerProvider.overrideWith(_EmptyRequests.new),
          outgoingRequestsControllerProvider.overrideWith(_FailingOutgoing.new),
          outgoingTempsProvider.overrideWithValue(const {}),
          avatarProvider(
            'mara@point.dev',
          ).overrideWith((ref) async => null),
          realtimeSyncCoordinatorProvider.overrideWithValue(sync),
        ],
        child: MaterialApp(
          theme: AppTheme.dark(pureBlack: true),
          home: const PeopleScreen(),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();

    expect(find.text('Mara'), findsOneWidget);
    expect(find.text('People unavailable'), findsNothing);
    expect(find.textContaining('Showing what is available'), findsOneWidget);
  });

  testWidgets('map reload drops stale tiles and exposes retry on error', (
    tester,
  ) async {
    var attempts = 0;
    final refresh = Completer<ServerTileInfo>();
    final container = ProviderContainer(
      retry: _noRetry,
      overrides: [
        serverTileInfoProvider.overrideWith((ref) async {
          attempts++;
          if (attempts == 1) {
            return const ServerTileInfo(
              tilesTemplate: 'https://private.example/{z}/{x}/{y}',
            );
          }
          return refresh.future;
        }),
      ],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: AppTheme.dark(pureBlack: true),
          home: const Scaffold(
            body: Stack(children: [MapAvailabilityOverlay()]),
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();

    expect(find.text('Loading map'), findsNothing);
    expect(container.read(tileSourceProvider), isNotNull);

    container.invalidate(serverTileInfoProvider);
    await tester.pump();
    expect(find.text('Loading map'), findsOneWidget);
    expect(container.read(tileSourceProvider), isNull);

    refresh.completeError(StateError('https://private.example failed'));
    await tester.pump();
    await tester.pump();

    expect(find.text('Map unavailable'), findsOneWidget);
    expect(find.textContaining('private.example'), findsNothing);
    expect(container.read(tileSourceProvider), isNull);
    final attemptsBeforeRetry = attempts;

    await tester.tap(find.text('Retry'));
    await tester.pump();
    expect(attempts, greaterThan(attemptsBeforeRetry));
  });

  testWidgets('avatar failure is visible and retryable beside the fallback', (
    tester,
  ) async {
    var attempts = 0;
    final sync = _RecordingSync();

    await tester.pumpWidget(
      ProviderScope(
        retry: _noRetry,
        overrides: [
          peopleControllerProvider.overrideWith(_RefreshablePeople.new),
          peopleWithPresenceProvider.overrideWithValue(const [_mara]),
          requestsControllerProvider.overrideWith(_EmptyRequests.new),
          outgoingRequestsControllerProvider.overrideWith(_EmptyOutgoing.new),
          outgoingTempsProvider.overrideWithValue(const {}),
          avatarProvider('mara@point.dev').overrideWith((ref) async {
            attempts++;
            throw StateError('avatar unavailable');
          }),
          realtimeSyncCoordinatorProvider.overrideWithValue(sync),
        ],
        child: MaterialApp(
          theme: AppTheme.dark(pureBlack: true),
          home: const PeopleScreen(),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();

    expect(find.text('Mara'), findsOneWidget);
    expect(find.text('Some photos could not load.'), findsOneWidget);
    final attemptsBeforeRetry = attempts;

    await tester.tap(find.text('Retry'));
    await tester.pump();
    expect(attempts, greaterThan(attemptsBeforeRetry));
  });

  test('avatar transport failure remains an AsyncError', () async {
    final api = PointApi(
      baseUrl: 'https://point.dev',
      client: MockClient((_) async => throw http.ClientException('offline')),
    );
    final container = ProviderContainer(
      retry: _noRetry,
      overrides: [
        authControllerProvider.overrideWith(_SignedInAuth.new),
        apiProvider.overrideWithValue(api),
      ],
    );
    addTearDown(container.dispose);

    await container.read(authControllerProvider.future);
    await expectLater(
      container.read(avatarProvider('mara@point.dev').future),
      throwsA(isA<http.ClientException>()),
    );
    expect(
      container.read(avatarProvider('mara@point.dev')).hasError,
      isTrue,
    );
  });
}
