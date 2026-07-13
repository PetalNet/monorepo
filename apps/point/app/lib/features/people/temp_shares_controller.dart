import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/people/people_controller.dart';
import 'package:point_app/features/people/people_presence.dart';
import 'package:point_app/features/relay/relay_controller.dart';
import 'package:point_app/features/settings/app_settings.dart';
import 'package:point_app/features/settings/settings_controller.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/theme/presence_tokens.dart';

/// Active temporary shares involving me, from the live server. Kept in sync by
/// the relay (`share.temp_created` WS event) and refreshed on create/stop.
class TempSharesController extends AsyncNotifier<List<TempShare>> {
  @override
  Future<List<TempShare>> build() async {
    final session = ref.watch(authControllerProvider).value;
    if (session == null) return const [];
    return ref.read(apiProvider).listTempShares(session.token);
  }

  Future<List<TempShare>> refresh() async {
    // Keep the last good list on a transient failure — a failed refresh (which
    // fires on unrelated WS events / create / stop) must NOT collapse .value to
    // null, which would drop active temp targets out of the relay's encrypt set.
    final prev = state.value;
    final next = await AsyncValue.guard(build);
    if (next.hasValue) {
      state = next;
      return next.value!;
    }
    state = AsyncData(prev ?? const []);
    Error.throwWithStackTrace(next.error!, next.stackTrace!);
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

  /// Apply a server-authoritative teardown before the reconciliation request
  /// completes. Returning the remaining rows lets the relay decide whether a
  /// cached peer fix is still authorized by another relationship.
  List<TempShare> removeLocally(String id) {
    final remaining = [
      for (final share in state.value ?? const <TempShare>[])
        if (share.id != id) share,
    ];
    state = AsyncData(remaining);
    return remaining;
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

/// MY incoming, not-yet-expired temp shares, keyed by the person sharing with
/// me. Keeping this separate from [myOutgoingTemps] preserves the one-way
/// relationship instead of making a temp share look mutual in the UI.
Map<String, TempShare> myIncomingTemps(
  List<TempShare> all,
  String? me,
  DateTime now,
) {
  if (me == null) return const {};
  return {
    for (final t in all)
      if (t.toUserId == me && t.expiresAt.isAfter(now)) t.fromUserId: t,
  };
}

/// Whether the current user may still retain a peer's decrypted fix after one
/// temporary row is removed. Outgoing shares do not grant viewing access; only
/// a permanent relationship or another active incoming share does.
bool retainsPeerLocationAfterTempTeardown({
  required Iterable<TempShare> remaining,
  required String? me,
  required String peer,
  required Iterable<String> permanentPeers,
  required DateTime now,
}) {
  if (permanentPeers.contains(peer)) return true;
  if (me == null) return false;
  return remaining.any(
    (share) =>
        share.fromUserId == peer &&
        share.toUserId == me &&
        share.expiresAt.isAfter(now),
  );
}

/// Peers whose last visible incoming temp relationship disappeared on a clock
/// tick. The first provider emission has no prior authorization snapshot and
/// therefore never evicts; permanent peers remain authorized.
Set<String> peersLosingTempLocationAccess({
  required Map<String, TempShare>? previous,
  required Map<String, TempShare> next,
  required Iterable<String> permanentPeers,
}) {
  if (previous == null) return const <String>{};
  return previous.keys.toSet()
    ..removeAll(next.keys)
    ..removeAll(permanentPeers);
}

/// Resolve stable identities for incoming temp-only senders. The exact handle
/// is authoritative; its local part is the honest fallback display name until
/// a profile relationship exists. Existing ongoing people are excluded so a
/// sender never appears twice.
List<Person> tempOnlySenderIdentities(
  Map<String, TempShare> incoming,
  Iterable<Person> ongoing,
) {
  final ongoingIds = ongoing.map((person) => person.userId).toSet();
  return [
    for (final userId in incoming.keys)
      if (!ongoingIds.contains(userId))
        Person(
          userId: userId,
          displayName: userId.split('@').first,
          presence: PresenceState.away,
          subtitle: userId,
        ),
  ];
}

/// Resolve temp-only sender identities against decrypted relay state. This is
/// intentionally pure so the privacy-critical transition from an API
/// relationship to a visible recipient location is independently testable.
List<Person> resolveIncomingTempPeople({
  required Map<String, TempShare> incoming,
  required Iterable<Person> ongoing,
  required Map<String, PeerFix> fixes,
  required Map<String, PeerPresence> serverPresence,
  required DateTime now,
  String? selfDomain,
  TimeFormat timeFormat = TimeFormat.h24,
}) => [
  for (final person in tempOnlySenderIdentities(incoming, ongoing))
    mergePresence(
      person,
      fixes[person.userId],
      serverPresence: serverPresence[person.userId],
      selfDomain: selfDomain,
      now: now,
      timeFormat: timeFormat,
    ),
];

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

/// MY active incoming temp shares, keyed by sender. The presence clock makes
/// expiry remove the recipient-facing relationship without another API call.
final incomingTempsProvider = Provider<Map<String, TempShare>>((ref) {
  final all = ref.watch(tempSharesControllerProvider).value ?? const [];
  final me = ref.watch(authControllerProvider).value?.userId;
  final now = ref.watch(presenceClockProvider).value ?? DateTime.now();
  return myIncomingTemps(all, me, now);
});

/// Incoming temp-only senders with the same decrypted live-location merge used
/// for permanent people. This is the recipient-side presentation identity: it
/// exists even when there is no `user_shares` row.
final incomingTempPeopleProvider = Provider<List<Person>>((ref) {
  final incoming = ref.watch(incomingTempsProvider);
  if (incoming.isEmpty) return const [];
  final ongoing = ref.watch(peopleWithPresenceProvider);
  final live = ref.watch(livePresenceProvider);
  final serverPresence = ref.watch(peerPresenceProvider);
  final now = ref.watch(presenceClockProvider).value ?? DateTime.now();
  final self = ref.watch(authControllerProvider).value?.userId;
  final selfDomain = self != null && self.contains('@')
      ? self.split('@').last
      : null;
  final timeFormat = ref.watch(settingsProvider.select((s) => s.timeFormat));
  return resolveIncomingTempPeople(
    incoming: incoming,
    ongoing: ongoing,
    fixes: {for (final entry in live.entries) entry.key: entry.value.target},
    serverPresence: serverPresence,
    selfDomain: selfDomain,
    now: now,
    timeFormat: timeFormat,
  );
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
