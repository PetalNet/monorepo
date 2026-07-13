import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/me/avatar_provider.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/theme/presence_tokens.dart';

/// The people the signed-in user shares with, from the live server
/// (`GET /api/shares`). Live presence + coordinates arrive over the WS in M2;
/// until a fix has been received a shared person shows as `away` with no map
/// marker, which is the honest state for a fresh relationship.
class PeopleController extends AsyncNotifier<List<Person>> {
  final Map<String, int> _profileVersions = {};
  int _refreshGeneration = 0;
  int _authorizationRevision = 0;

  /// Advances only after an authoritative shares response succeeds. The relay
  /// uses this to distinguish a real omission (revoke) from an offline refresh
  /// that must retain the last-known encrypted-at-rest location cache.
  int get authorizationRevision => _authorizationRevision;

  @override
  Future<List<Person>> build() async {
    final session = ref.watch(authControllerProvider).value;
    if (session == null) return const [];
    final api = ref.read(apiProvider);
    final shares = await api.activeShares(session.token);
    _authorizationRevision++;
    return shares.map(_personFromShare).toList();
  }

  /// Re-fetch WITHOUT flashing through `AsyncLoading` — keeps the previous list
  /// visible and, critically, keeps `.value` non-null so the share-target
  /// listener never briefly sees `[]` and stops encrypting to everyone.
  Future<List<Person>> refresh() async {
    final generation = ++_refreshGeneration;
    final next = await AsyncValue.guard(build);
    if (generation != _refreshGeneration) {
      if (next.hasValue) return next.value!;
      Error.throwWithStackTrace(next.error!, next.stackTrace!);
    }
    if (next.hasValue) {
      _invalidateChangedAvatars(state.value, next.value!);
      state = next;
      return next.value!;
    }
    // Assigning the error through AsyncNotifier preserves the previous value in
    // Riverpod's multi-state AsyncValue. Consumers can therefore keep showing
    // trusted last-good people while also telling the user the refresh failed.
    state = next;
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

  /// Apply a content-light `profile.updated` frame. Avatar invalidation happens
  /// in the same WS turn; the name then comes from the authoritative shares
  /// response without flashing the existing people list away. A failed refresh
  /// leaves last-good identity visible and records the normal refresh error.
  Future<void> profileUpdated(
    String userId, {
    required int profileVersion,
    required bool avatarChanged,
  }) async {
    final previousVersion = _profileVersions[userId];
    if (previousVersion != null && profileVersion < previousVersion) return;
    _profileVersions[userId] = profileVersion;
    if (avatarChanged) ref.invalidate(avatarProvider(userId));

    try {
      await refresh();
    } on Object {
      // Keep the same non-throwing WS behavior as other advisory live frames.
      // `refresh` records the error while preserving the last-good list.
    }
  }

  void _invalidateChangedAvatars(
    List<Person>? previous,
    List<Person> next,
  ) {
    if (previous == null) return;
    final priorVersions = {
      for (final person in previous) person.userId: person.profileVersion,
    };
    for (final person in next) {
      final prior = priorVersions[person.userId];
      if (prior != null &&
          person.profileVersion != null &&
          prior != person.profileVersion) {
        ref.invalidate(avatarProvider(person.userId));
      }
    }
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
      profileVersion: DateTime.tryParse(
        share['profile_version'] as String? ?? '',
      ),
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
    AsyncNotifierProvider<PeopleController, List<Person>>(PeopleController.new);
