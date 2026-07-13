import 'dart:async';
import 'dart:collection';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/me/avatar_provider.dart';
import 'package:point_app/features/people/people_controller.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/api/point_api.dart';
import 'package:point_app/services/auth_controller.dart';

const _userId = 'mara@point.dev';

class _SignedInAuth extends AuthController {
  @override
  Future<Session?> build() async => const Session(
    token: 'token',
    userId: 'eli@point.dev',
    displayName: 'Eli',
    isAdmin: false,
  );
}

class _ProfileApi implements PointApi {
  final responses = Queue<Future<List<Map<String, dynamic>>>>();

  @override
  Future<List<Map<String, dynamic>>> activeShares(String token) =>
      responses.removeFirst();

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('${invocation.memberName}');
}

Map<String, dynamic> _share(String displayName) => {
  'user_id': _userId,
  'display_name': displayName,
  'since': '2026-07-13T00:00:00Z',
  'rekeyed_at': '2026-07-13T00:00:00Z',
};

void main() {
  test('avatar cache revalidates bytes with ETag after invalidation', () async {
    final cache = AvatarCache();
    String? sentEtag;

    final first = await cache.load(
      'server\u0000mara',
      (_) async => AvatarResponse(
        statusCode: 200,
        bytes: Uint8List.fromList([1, 2, 3]),
        etag: '"avatar-v1"',
      ),
    );
    final second = await cache.load('server\u0000mara', (etag) async {
      sentEtag = etag;
      return const AvatarResponse(statusCode: 304);
    });

    expect(sentEtag, '"avatar-v1"');
    expect(second, same(first));
  });

  test('avatar cache replaces stale bytes with definitive absence', () async {
    final cache = AvatarCache();
    await cache.load(
      'server\u0000mara',
      (_) async => AvatarResponse(
        statusCode: 200,
        bytes: Uint8List.fromList([1]),
        etag: '"avatar-v1"',
      ),
    );

    expect(
      await cache.load('server\u0000mara', (etag) async {
        expect(etag, '"avatar-v1"');
        return const AvatarResponse(statusCode: 404);
      }),
      isNull,
    );
  });

  test('older avatar response cannot replace newer validation', () async {
    final cache = AvatarCache();
    await cache.load(
      'server\u0000mara',
      (_) async => AvatarResponse(
        statusCode: 200,
        bytes: Uint8List.fromList([1]),
        etag: '"avatar-v1"',
      ),
    );
    final older = Completer<AvatarResponse>();
    final newer = Completer<AvatarResponse>();
    final olderLoad = cache.load('server\u0000mara', (_) => older.future);
    final newerLoad = cache.load('server\u0000mara', (_) => newer.future);
    newer.complete(
      AvatarResponse(
        statusCode: 200,
        bytes: Uint8List.fromList([2]),
        etag: '"avatar-v2"',
      ),
    );
    await newerLoad;
    older.complete(const AvatarResponse(statusCode: 404));
    await olderLoad;

    String? validatedEtag;
    await cache.load('server\u0000mara', (etag) async {
      validatedEtag = etag;
      return const AvatarResponse(statusCode: 304);
    });
    expect(validatedEtag, '"avatar-v2"');
  });

  test('event refresh wins over an older general people refresh', () async {
    final api = _ProfileApi()..responses.add(Future.value([_share('Mara')]));
    final container = ProviderContainer(
      overrides: [
        authControllerProvider.overrideWith(_SignedInAuth.new),
        apiProvider.overrideWithValue(api),
      ],
    );
    addTearDown(container.dispose);
    await container.read(authControllerProvider.future);
    await container.read(peopleControllerProvider.future);
    final notifier = container.read(peopleControllerProvider.notifier);
    final older = Completer<List<Map<String, dynamic>>>();
    final newer = Completer<List<Map<String, dynamic>>>();
    api.responses.addAll([older.future, newer.future]);

    final olderRefresh = notifier.refresh();
    final newerUpdate = notifier.profileUpdated(
      _userId,
      profileVersion: 11,
      avatarChanged: false,
    );
    newer.complete([_share('Mara Chen')]);
    await newerUpdate;
    older.complete([_share('Mara')]);
    await olderRefresh;

    expect(
      container.read(peopleControllerProvider).value?.single.displayName,
      'Mara Chen',
    );
  });
}
