import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/theme/presence_tokens.dart';

/// The people the signed-in user shares with, from the live server
/// (`GET /api/shares`). Live presence + coordinates arrive over the WS in M2;
/// until a fix has been received a shared person shows as `away` with no map
/// marker, which is the honest state for a fresh relationship.
class PeopleController extends AsyncNotifier<List<Person>> {
  @override
  Future<List<Person>> build() async {
    final session = ref.watch(authControllerProvider).value;
    if (session == null) return const [];
    final api = ref.read(apiProvider);
    final shares = await api.activeShares(session.token);
    return shares.map(_personFromShare).toList();
  }

  /// Re-fetch WITHOUT flashing through `AsyncLoading` — keeps the previous list
  /// visible and, critically, keeps `.value` non-null so the share-target
  /// listener never briefly sees `[]` and stops encrypting to everyone.
  Future<List<Person>> refresh() async {
    final previous = state.value ?? const <Person>[];
    final next = await AsyncValue.guard(build);
    if (next.hasValue) {
      state = next;
      return next.value!;
    }
    state = AsyncData(previous);
    Error.throwWithStackTrace(next.error!, next.stackTrace!);
  }

  /// Apply a live share teardown before the network refresh completes. This
  /// removes the peer from People + Map in the same WS turn and prevents a
  /// stale "Dark since" row lingering after the relationship is gone.
  void removeLocally(String userId) {
    final current = state.value;
    if (current == null) return;
    state = AsyncData(withoutSharedPerson(current, userId));
  }

  Person _personFromShare(Map<String, dynamic> share) {
    final userId = share['user_id'] as String;
    final displayName =
        share['display_name'] as String? ?? userId.split('@').first;
    return Person(
      userId: userId,
      displayName: displayName,
      // No live presence yet (WS lands in M2); default to away, no location.
      presence: PresenceState.away,
      subtitle: userId,
      rekeyedAt: DateTime.tryParse(share['rekeyed_at'] as String? ?? ''),
      shareSince: DateTime.tryParse(share['since'] as String? ?? ''),
    );
  }
}

/// Pure client half of a live teardown. The Map is derived from this same
/// accepted-person list, so removing here drops the peer from both surfaces.
List<Person> withoutSharedPerson(List<Person> people, String userId) =>
    people.where((p) => p.userId != userId).toList();

final peopleControllerProvider =
    AsyncNotifierProvider<PeopleController, List<Person>>(
      PeopleController.new,
    );
