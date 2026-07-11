import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/auth_controller.dart';

/// Ghost on/off (GO-bar #6). Server-enforced + persisted; v1 is a plain toggle
/// (no timers/rules). Reads the current state from the server and flips it,
/// with an optimistic update so the safety-critical control feels instant.
class GhostController extends AsyncNotifier<GhostState> {
  @override
  Future<GhostState> build() async {
    final session = ref.watch(authControllerProvider).value;
    if (session == null) return const GhostState(active: false);
    return ref.read(apiProvider).getGhost(session.token);
  }

  /// `sharing == true` means ghost OFF (broadcasting). The server stores the
  /// ghost flag, so we send `active = !sharing`.
  Future<void> setSharing({required bool sharing}) async {
    final session = ref.read(authControllerProvider).value;
    if (session == null) return;
    // Optimistic: reflect the new state immediately.
    state = AsyncData(GhostState(active: !sharing));
    state = await AsyncValue.guard(
      () => ref.read(apiProvider).setGhost(session.token, active: !sharing),
    );
  }
}

final ghostControllerProvider =
    AsyncNotifierProvider<GhostController, GhostState>(GhostController.new);
