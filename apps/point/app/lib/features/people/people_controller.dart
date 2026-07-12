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
  Future<void> refresh() async {
    state = await AsyncValue.guard(build);
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
    );
  }
}

final peopleControllerProvider =
    AsyncNotifierProvider<PeopleController, List<Person>>(
  PeopleController.new,
);
