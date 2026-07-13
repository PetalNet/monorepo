import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/location/location_providers.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/auth_controller.dart';

enum GhostMutationPhase { running, failed }

class GhostMutation {
  const GhostMutation(this.phase);

  final GhostMutationPhase phase;
  bool get isRunning => phase == GhostMutationPhase.running;
}

class GhostMutations extends Notifier<Map<String, GhostMutation>> {
  @override
  Map<String, GhostMutation> build() => const {};

  void setPhase(String key, GhostMutationPhase phase) {
    state = {...state, key: GhostMutation(phase)};
  }

  void clear(String key) {
    if (!state.containsKey(key)) return;
    state = {...state}..remove(key);
  }
}

final ghostMutationsProvider =
    NotifierProvider<GhostMutations, Map<String, GhostMutation>>(
      GhostMutations.new,
    );

/// Ghost on/off (GO-bar #6). Server-enforced + persisted; v1 is a plain toggle
/// (no timers/rules). Reads the current state from the server and flips it,
/// with an optimistic update so the safety-critical control feels instant.
class GhostController extends AsyncNotifier<GhostState> {
  /// Whether [state] holds a server-CONFIRMED value. The signed-out build
  /// returns a placeholder, and a rollback baseline must never be an
  /// unconfirmed reading: rolling a failed go-dark back to a placeholder's
  /// "sharing" would silently flip a user who asked for dark into
  /// broadcasting (v1.2.1 review).
  bool _confirmed = false;

  @override
  Future<GhostState> build() async {
    final session = ref.watch(authControllerProvider).value;
    if (session == null) {
      _confirmed = false;
      return const GhostState(active: false);
    }
    final confirmed = await ref.read(apiProvider).getGhost(session.token);
    _confirmed = true;
    return confirmed;
  }

  Future<GhostState> refresh() async {
    final session = ref.read(authControllerProvider).value;
    if (session == null) return const GhostState(active: false);
    final confirmed = await ref.read(apiProvider).getGhost(session.token);
    _confirmed = true;
    state = AsyncData(confirmed);
    return confirmed;
  }

  /// `sharing == true` means ghost OFF (broadcasting). The server stores the
  /// ghost flag, so we send `active = !sharing`.
  ///
  /// Safety-critical: on a server failure we roll BOTH the engine and the
  /// displayed state back to what was actually confirmed, rather than leaving
  /// the UI, the engine, and the server disagreeing. We never default the
  /// display to "sharing" on error (which would tell a user they're visible
  /// when the engine has gone dark).
  Future<bool> setSharing({required bool sharing}) async {
    const mutationKey = 'global';
    if (ref.read(ghostMutationsProvider).values.any((item) => item.isRunning)) {
      return false;
    }
    final session = ref.read(authControllerProvider).value;
    if (session == null) return false;
    final engine = ref.read(locationServiceProvider);
    // Last state the server actually CONFIRMED; fall back to the ghosted
    // (safer) reading if we've never confirmed one — including when the
    // current value is only the signed-out placeholder.
    final previous = _confirmed && state.value != null
        ? state.value!
        : const GhostState(active: true);

    // Drive the engine + reflect the intent optimistically — preserving the
    // per-person hide set (a global toggle must not wipe it).
    engine.setSharing(sharing: sharing);
    state = AsyncData(previous.copyWith(active: !sharing));
    ref
        .read(ghostMutationsProvider.notifier)
        .setPhase(mutationKey, GhostMutationPhase.running);

    try {
      final confirmed = await ref
          .read(apiProvider)
          .setGhost(session.token, active: !sharing);
      _confirmed = true;
      state = AsyncData(confirmed);
      ref.read(ghostMutationsProvider.notifier).clear(mutationKey);
      return true;
    } on Object {
      // Roll back FAIL-CLOSED (v1.2.1 review): the engine may land on
      // "broadcasting" only when the last CONFIRMED state was sharing AND
      // sharing is what was being asked for. A failed go-dark must never
      // resume broadcasting against the user's ask, and an unconfirmed
      // placeholder must never masquerade as a "sharing" baseline. The
      // display mirrors the ENGINE (what actually leaves the device), so it
      // still snaps back visibly when a go-light fails.
      final safeSharing = previous.isSharing && sharing;
      engine.setSharing(sharing: safeSharing);
      state = AsyncData(previous.copyWith(active: !safeSharing));
      ref
          .read(ghostMutationsProvider.notifier)
          .setPhase(mutationKey, GhostMutationPhase.failed);
      return false;
    }
  }

  /// Per-person hide: go dark to (or reveal to) a single person. Optimistic,
  /// rolling back the set on a server failure.
  Future<bool> setHiddenFrom(String userId, {required bool hidden}) async {
    if (ref.read(ghostMutationsProvider).values.any((item) => item.isRunning)) {
      return false;
    }
    final session = ref.read(authControllerProvider).value;
    if (session == null) return false;
    final previous = state.value ?? const GhostState(active: false);
    final next = {...previous.hiddenFrom};
    if (hidden) {
      next.add(userId);
    } else {
      next.remove(userId);
    }
    state = AsyncData(previous.copyWith(hiddenFrom: next));
    ref
        .read(ghostMutationsProvider.notifier)
        .setPhase(userId, GhostMutationPhase.running);
    try {
      await ref
          .read(apiProvider)
          .setGhostTarget(session.token, userId, ghosted: hidden);
      ref.read(ghostMutationsProvider.notifier).clear(userId);
      return true;
    } on Object {
      state = AsyncData(previous);
      ref
          .read(ghostMutationsProvider.notifier)
          .setPhase(userId, GhostMutationPhase.failed);
      return false;
    }
  }
}

final ghostControllerProvider =
    AsyncNotifierProvider<GhostController, GhostState>(GhostController.new);
