import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/people/people_controller.dart';
import 'package:point_app/features/people/people_presence.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/auth_controller.dart';

/// Active temporary shares involving me, from the live server. Kept in sync by
/// the relay (`share.temp_created` WS event) and refreshed on create/stop.
class TempSharesController extends AsyncNotifier<List<TempShare>> {
  @override
  Future<List<TempShare>> build() async {
    final session = ref.watch(authControllerProvider).value;
    if (session == null) return const [];
    return ref.read(apiProvider).listTempShares(session.token);
  }

  Future<void> refresh() async {
    state = await AsyncValue.guard(build);
  }

  /// Start a one-way temp share: [toUserId] sees my location for [minutes].
  Future<void> share(String toUserId, {required int minutes}) async {
    final session = ref.read(authControllerProvider).value;
    if (session == null) return;
    await ref.read(apiProvider).createTempShare(session.token, toUserId, minutes);
    await refresh();
  }

  /// Stop one of my outgoing temp shares early.
  Future<void> stop(String id) async {
    final session = ref.read(authControllerProvider).value;
    if (session == null) return;
    await ref.read(apiProvider).deleteTempShare(session.token, id);
    await refresh();
  }
}

final tempSharesControllerProvider =
    AsyncNotifierProvider<TempSharesController, List<TempShare>>(
  TempSharesController.new,
);

/// MY outgoing, not-yet-expired temp shares, keyed by the person I'm sharing to.
/// Pure so it's unit-testable without a container.
Map<String, TempShare> myOutgoingTemps(
  List<TempShare> all,
  String? me,
  DateTime now,
) {
  if (me == null) return const {};
  return {
    for (final t in all)
      if (t.fromUserId == me && t.expiresAt.isAfter(now)) t.toUserId: t,
  };
}

/// Everyone I should relay my location to: ongoing share ids ∪ outgoing temp
/// targets. Pure.
List<String> computeShareTargets(
  List<String> ongoingIds,
  Iterable<String> tempTargets,
) =>
    {...ongoingIds, ...tempTargets}.toList();

/// MY active outgoing temp shares, keyed by target. Watches the presence clock
/// so an expired "till HH:MM" drops on its own.
final outgoingTempsProvider = Provider<Map<String, TempShare>>((ref) {
  final all = ref.watch(tempSharesControllerProvider).value ?? const [];
  final me = ref.watch(authControllerProvider).value?.userId;
  final now = ref.watch(presenceClockProvider).value ?? DateTime.now();
  return myOutgoingTemps(all, me, now);
});

/// Everyone I should be encrypting + relaying my location to: ongoing shares
/// PLUS active outgoing temp targets. Null while the shares list is still
/// loading, so the relay never clears its targets on a transient no-value.
final shareTargetsProvider = Provider<List<String>?>((ref) {
  final peopleAsync = ref.watch(peopleControllerProvider);
  if (!peopleAsync.hasValue) return null;
  final temps = ref.watch(outgoingTempsProvider);
  return computeShareTargets(
    peopleAsync.value!.map((p) => p.userId).toList(),
    temps.keys,
  );
});
