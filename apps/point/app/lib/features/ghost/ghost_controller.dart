import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/location/location_providers.dart';
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
  ///
  /// Safety-critical: on a server failure we roll BOTH the engine and the
  /// displayed state back to what was actually confirmed, rather than leaving
  /// the UI, the engine, and the server disagreeing. We never default the
  /// display to "sharing" on error (which would tell a user they're visible
  /// when the engine has gone dark).
  Future<void> setSharing({required bool sharing}) async {
    final session = ref.read(authControllerProvider).value;
    if (session == null) return;
    final engine = ref.read(locationServiceProvider);
    // Last state the server actually confirmed; fall back to the ghosted
    // (safer) reading if we've never confirmed one.
    final previous = state.value ?? const GhostState(active: true);

    // Drive the engine + reflect the intent optimistically — preserving the
    // per-person hide set (a global toggle must not wipe it).
    engine.setSharing(sharing: sharing);
    state = AsyncData(previous.copyWith(active: !sharing));

    try {
      final confirmed =
          await ref.read(apiProvider).setGhost(session.token, active: !sharing);
      state = AsyncData(confirmed);
    } on Object {
      // Roll the engine + the display back to the last confirmed state so the
      // three never silently diverge on the one safety-critical control. The
      // toggle visibly snaps back, signalling the failure without throwing into
      // the fire-and-forget tap handler.
      engine.setSharing(sharing: previous.isSharing);
      state = AsyncData(previous);
    }
  }

  /// Per-person hide: go dark to (or reveal to) a single person. Optimistic,
  /// rolling back the set on a server failure.
  Future<void> setHiddenFrom(String userId, {required bool hidden}) async {
    final session = ref.read(authControllerProvider).value;
    if (session == null) return;
    final previous = state.value ?? const GhostState(active: false);
    final next = {...previous.hiddenFrom};
    if (hidden) {
      next.add(userId);
    } else {
      next.remove(userId);
    }
    state = AsyncData(previous.copyWith(hiddenFrom: next));
    try {
      await ref
          .read(apiProvider)
          .setGhostTarget(session.token, userId, ghosted: hidden);
    } on Object {
      state = AsyncData(previous);
    }
  }
}

final ghostControllerProvider =
    AsyncNotifierProvider<GhostController, GhostState>(GhostController.new);
