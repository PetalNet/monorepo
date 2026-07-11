import 'package:flutter/foundation.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/app/config.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/api/point_api.dart';
import 'package:point_app/services/session_store.dart';

/// The configured home-server client.
final apiProvider = Provider<PointApi>((ref) {
  final api = PointApi(baseUrl: AppConfig.serverBaseUrl);
  ref.onDispose(api.close);
  return api;
});

final sessionStoreProvider = Provider<SessionStore>((_) => SessionStore());

/// Auth state: `null` session = signed out. Exposed as a [ValueListenable] of
/// "is authenticated" for the kaisel guard, so an auth change flips routing via
/// `router.set` without rebuilding/reset­ting the router (D-015 acceptance bar).
class AuthController extends AsyncNotifier<Session?> {
  final ValueNotifier<bool> loggedIn = ValueNotifier<bool>(false);

  @override
  Future<Session?> build() async {
    // `loggedIn` is a lifetime field captured once by the kaisel guard, so it
    // must survive any `build()` re-run — do NOT tie its disposal to a single
    // build. (Provider disposal of an app-lifetime auth controller is a no-op
    // in practice; the notifier field is cheap.)
    final restored = await ref.read(sessionStoreProvider).read();
    loggedIn.value = restored != null;
    return restored;
  }

  Session? get session => state.value;

  Future<void> login(String username, String password) async {
    final api = ref.read(apiProvider);
    state = const AsyncLoading();
    state = await AsyncValue.guard(() async {
      final s = await api.login(username: username, password: password);
      await ref.read(sessionStoreProvider).write(s);
      loggedIn.value = true;
      return s;
    });
    if (state.hasError) loggedIn.value = false;
  }

  Future<void> register({
    required String username,
    required String password,
    String? displayName,
    String? inviteCode,
  }) async {
    final api = ref.read(apiProvider);
    state = const AsyncLoading();
    state = await AsyncValue.guard(() async {
      final s = await api.register(
        username: username,
        password: password,
        displayName: displayName,
        inviteCode: inviteCode,
      );
      await ref.read(sessionStoreProvider).write(s);
      loggedIn.value = true;
      return s;
    });
    if (state.hasError) loggedIn.value = false;
  }

  Future<void> logout() async {
    await ref.read(sessionStoreProvider).clear();
    loggedIn.value = false;
    state = const AsyncData(null);
  }
}

final authControllerProvider =
    AsyncNotifierProvider<AuthController, Session?>(AuthController.new);
