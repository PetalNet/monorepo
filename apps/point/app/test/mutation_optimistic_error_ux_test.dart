import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:point_app/features/ghost/ghost_controller.dart';
import 'package:point_app/features/people/requests_controller.dart';
import 'package:point_app/features/people/temp_shares_controller.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/api/point_api.dart';
import 'package:point_app/services/auth_controller.dart';

class _SignedInAuth extends AuthController {
  @override
  Future<Session?> build() async => const Session(
    token: 'token',
    userId: 'eli@point.dev',
    displayName: 'Eli',
    isAdmin: false,
  );
}

ProviderContainer _container(PointApi api) => ProviderContainer(
  overrides: [
    authControllerProvider.overrideWith(_SignedInAuth.new),
    apiProvider.overrideWithValue(api),
  ],
);

void main() {
  test(
    'decline removes immediately, blocks duplicates, and rolls back',
    () async {
      final response = Completer<http.Response>();
      var rejects = 0;
      var refreshFails = false;
      final api = PointApi(
        baseUrl: 'https://point.dev',
        client: MockClient((request) async {
          if (request.url.path.endsWith('/reject')) {
            rejects++;
            return response.future;
          }
          if (request.url.path == '/api/shares/requests') {
            if (refreshFails) throw StateError('offline');
            return http.Response(
              '[{"id":"r1","from_user_id":"mara@point.dev",'
              '"from_display_name":"Mara",'
              '"created_at":"2026-07-13T15:30:00Z"}]',
              200,
            );
          }
          return http.Response('[]', 200);
        }),
      );
      final container = _container(api);
      addTearDown(container.dispose);
      await container.read(authControllerProvider.future);
      final initial = await container.read(requestsControllerProvider.future);
      final controller = container.read(requestsControllerProvider.notifier);

      final first = controller.decline(initial.single);
      await Future<void>.delayed(Duration.zero);
      expect(container.read(requestsControllerProvider).value, isEmpty);
      expect(
        container.read(requestMutationsProvider)['r1']?.phase,
        MutationPhase.running,
      );

      expect(await controller.decline(initial.single), MutationOutcome.ignored);
      expect(rejects, 1);

      response.complete(http.Response('{"error":"offline"}', 503));
      expect(await first, MutationOutcome.failed);
      expect(container.read(requestsControllerProvider).value, initial);
      expect(
        container.read(requestMutationsProvider)['r1']?.phase,
        MutationPhase.failed,
      );

      refreshFails = true;
      await expectLater(controller.refresh(), throwsA(isA<StateError>()));
      expect(container.read(requestsControllerProvider).value, initial);
    },
  );

  test('temporary stop removes immediately and restores on failure', () async {
    final response = Completer<http.Response>();
    var deletes = 0;
    final api = PointApi(
      baseUrl: 'https://point.dev',
      client: MockClient((request) async {
        if (request.method == 'DELETE') {
          deletes++;
          return response.future;
        }
        return http.Response(
          '[{"id":"t1","from_user_id":"eli@point.dev",'
          '"to_user_id":"mara@point.dev",'
          '"expires_at":"2026-07-14T15:30:00Z"}]',
          200,
        );
      }),
    );
    final container = _container(api);
    addTearDown(container.dispose);
    await container.read(authControllerProvider.future);
    final initial = await container.read(tempSharesControllerProvider.future);
    final controller = container.read(tempSharesControllerProvider.notifier);

    final first = controller.stop('t1');
    await Future<void>.delayed(Duration.zero);
    expect(container.read(tempSharesControllerProvider).value, isEmpty);
    expect(
      container.read(tempShareMutationsProvider)['t1']?.phase,
      TempShareMutationPhase.running,
    );
    expect(await controller.stop('t1'), MutationOutcome.ignored);
    expect(deletes, 1);

    response.complete(http.Response('{"error":"offline"}', 503));
    expect(await first, MutationOutcome.failed);
    expect(container.read(tempSharesControllerProvider).value, initial);
    expect(
      container.read(tempShareMutationsProvider)['t1']?.phase,
      TempShareMutationPhase.failed,
    );
  });

  test('stale refreshes cannot resurrect a committed request', () async {
    final staleRefresh = Completer<http.Response>();
    var requestReads = 0;
    const body =
        '[{"id":"r1","from_user_id":"mara@point.dev",'
        '"from_display_name":"Mara",'
        '"created_at":"2026-07-13T15:30:00Z"}]';
    final api = PointApi(
      baseUrl: 'https://point.dev',
      client: MockClient((request) async {
        if (request.url.path == '/api/shares/requests') {
          requestReads++;
          if (requestReads == 2) return staleRefresh.future;
          return http.Response(body, 200);
        }
        if (request.url.path.endsWith('/reject')) {
          return http.Response('{"ok":true}', 200);
        }
        return http.Response('[]', 200);
      }),
    );
    final container = _container(api);
    addTearDown(container.dispose);
    await container.read(authControllerProvider.future);
    final initial = await container.read(requestsControllerProvider.future);
    final controller = container.read(requestsControllerProvider.notifier);

    final olderRefresh = controller.refresh();
    await Future<void>.delayed(Duration.zero);
    expect(await controller.decline(initial.single), MutationOutcome.succeeded);
    expect(container.read(requestsControllerProvider).value, isEmpty);

    staleRefresh.complete(http.Response(body, 200));
    await olderRefresh;
    expect(container.read(requestsControllerProvider).value, isEmpty);
  });

  test('stale temp response stays filtered after a committed stop', () async {
    const body =
        '[{"id":"t1","from_user_id":"eli@point.dev",'
        '"to_user_id":"mara@point.dev",'
        '"expires_at":"2026-07-14T15:30:00Z"}]';
    final api = PointApi(
      baseUrl: 'https://point.dev',
      client: MockClient((request) async {
        if (request.method == 'DELETE') {
          return http.Response('{"ok":true}', 200);
        }
        return http.Response(body, 200);
      }),
    );
    final container = _container(api);
    addTearDown(container.dispose);
    await container.read(authControllerProvider.future);
    await container.read(tempSharesControllerProvider.future);

    expect(
      await container.read(tempSharesControllerProvider.notifier).stop('t1'),
      MutationOutcome.succeeded,
    );
    expect(container.read(tempSharesControllerProvider).value, isEmpty);
    expect(container.read(tempShareMutationsProvider), isEmpty);
  });

  test('per-person ghost rollback exposes a retryable failure state', () async {
    final response = Completer<http.Response>();
    var puts = 0;
    final api = PointApi(
      baseUrl: 'https://point.dev',
      client: MockClient((request) async {
        if (request.method == 'PUT') {
          puts++;
          return response.future;
        }
        return http.Response('{"active":false,"targets":[]}', 200);
      }),
    );
    final container = _container(api);
    addTearDown(container.dispose);
    await container.read(authControllerProvider.future);
    await container.read(ghostControllerProvider.future);
    final controller = container.read(ghostControllerProvider.notifier);

    final first = controller.setHiddenFrom('mara@point.dev', hidden: true);
    await Future<void>.delayed(Duration.zero);
    expect(
      container
          .read(ghostControllerProvider)
          .value
          ?.isHiddenFrom('mara@point.dev'),
      isTrue,
    );
    expect(
      container.read(ghostMutationsProvider)['mara@point.dev']?.phase,
      GhostMutationPhase.running,
    );
    expect(await controller.setSharing(sharing: false), isFalse);
    expect(
      await controller.setHiddenFrom('mara@point.dev', hidden: true),
      isFalse,
    );
    expect(puts, 1);

    response.complete(http.Response('{"error":"offline"}', 503));
    expect(await first, isFalse);
    expect(
      container
          .read(ghostControllerProvider)
          .value
          ?.isHiddenFrom('mara@point.dev'),
      isFalse,
    );
    expect(
      container.read(ghostMutationsProvider)['mara@point.dev']?.phase,
      GhostMutationPhase.failed,
    );
  });

  test('ongoing stop blocks duplicate taps and exposes retry state', () async {
    final response = Completer<http.Response>();
    var deletes = 0;
    final api = PointApi(
      baseUrl: 'https://point.dev',
      client: MockClient((request) async {
        if (request.method == 'DELETE') {
          deletes++;
          return response.future;
        }
        return http.Response('[]', 200);
      }),
    );
    final container = _container(api);
    addTearDown(container.dispose);
    await container.read(authControllerProvider.future);
    final controller = container.read(
      stopSharingMutationsProvider.notifier,
    );

    final first = controller.stop('mara@point.dev');
    await Future<void>.delayed(Duration.zero);
    expect(
      container.read(stopSharingMutationsProvider)['mara@point.dev'],
      MutationPhase.running,
    );
    expect(
      await controller.stop('mara@point.dev'),
      MutationOutcome.ignored,
    );
    expect(deletes, 1);

    response.complete(http.Response('{"error":"offline"}', 503));
    expect(await first, MutationOutcome.failed);
    expect(
      container.read(stopSharingMutationsProvider)['mara@point.dev'],
      MutationPhase.failed,
    );
  });

  test('ongoing stop stays guarded until reconciliation finishes', () async {
    final peopleResponse = Completer<http.Response>();
    final requestsResponse = Completer<http.Response>();
    var deletes = 0;
    final api = PointApi(
      baseUrl: 'https://point.dev',
      client: MockClient((request) async {
        if (request.method == 'DELETE') {
          deletes++;
          return http.Response('{"ok":true}', 200);
        }
        if (request.url.path == '/api/shares') return peopleResponse.future;
        if (request.url.path == '/api/shares/requests') {
          return requestsResponse.future;
        }
        return http.Response('[]', 200);
      }),
    );
    final container = _container(api);
    addTearDown(container.dispose);
    await container.read(authControllerProvider.future);
    final controller = container.read(stopSharingMutationsProvider.notifier);

    final first = controller.stop('mara@point.dev');
    await Future<void>.delayed(Duration.zero);
    expect(
      container.read(stopSharingMutationsProvider)['mara@point.dev'],
      MutationPhase.running,
    );
    expect(
      await controller.stop('mara@point.dev'),
      MutationOutcome.ignored,
    );
    expect(deletes, 1);

    peopleResponse.complete(http.Response('[]', 200));
    requestsResponse.complete(http.Response('[]', 200));
    expect(await first, MutationOutcome.succeeded);
    expect(container.read(stopSharingMutationsProvider), isEmpty);
  });
}
