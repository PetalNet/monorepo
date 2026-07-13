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
    // Keep the last good list on a transient failure — a failed refresh (which
    // fires on unrelated WS events / create / stop) must NOT collapse .value to
    // null, which would drop active temp targets out of the relay's encrypt set.
    final prev = state.value;
    final next = await AsyncValue.guard(build);
    state = next.hasValue ? next : AsyncData(prev ?? const []);
  }

  /// Start a one-way temp share: [toUserId] sees my location for [minutes].
  Future<void> share(String toUserId, {required int minutes}) async {
    final session = ref.read(authControllerProvider).value;
    if (session == null) return;
    await ref
        .read(apiProvider)
        .createTempShare(session.token, toUserId, minutes);
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
) => {...ongoingIds, ...tempTargets}.toList();

/// MY active outgoing temp shares, keyed by target. Watches the presence clock
/// so an expired "till HH:MM" drops on its own.
final outgoingTempsProvider = Provider<Map<String, TempShare>>((ref) {
  final all = ref.watch(tempSharesControllerProvider).value ?? const [];
  final me = ref.watch(authControllerProvider).value?.userId;
  final now = ref.watch(presenceClockProvider).value ?? DateTime.now();
  return myOutgoingTemps(all, me, now);
});

/// Everyone I should relay my location to. `all` = ongoing shares ∪ active
/// outgoing temp targets. `tempOnly` = temp targets that are NOT also ongoing
/// shares — the relay must form the MLS group with these unconditionally (a
/// one-way temp is asymmetric; the recipient never initiates). Null while the
/// shares list is loading, so the relay never clears targets on a transient
/// no-value.
typedef ShareTargets = ({
  List<String> all,
  Set<String> tempOnly,
  Map<String, DateTime> peerRekeyedAt,
  Map<String, DateTime> shareSince,
});

final shareTargetsProvider = Provider<ShareTargets?>((ref) {
  final peopleAsync = ref.watch(peopleControllerProvider);
  if (!peopleAsync.hasValue) return null;
  final ongoing = peopleAsync.value!.map((p) => p.userId).toSet();
  final temps = ref.watch(outgoingTempsProvider).keys.toSet();
  return (
    all: computeShareTargets(ongoing.toList(), temps),
    tempOnly: temps.difference(ongoing),
    peerRekeyedAt: {
      for (final person in peopleAsync.value!)
        if (person.rekeyedAt != null) person.userId: person.rekeyedAt!,
    },
    shareSince: {
      for (final person in peopleAsync.value!)
        if (person.shareSince != null) person.userId: person.shareSince!,
    },
  );
});
