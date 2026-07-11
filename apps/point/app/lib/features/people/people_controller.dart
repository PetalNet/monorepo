import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/theme/presence_tokens.dart';

/// The people the signed-in user shares with.
///
/// Sample data for now (representative of the real share graph) so the
/// People and Map surfaces render and can be driven in the loop.
// TODO(fable): back with PointApi.activeShares + the live WS presence stream.
final peopleProvider = Provider<List<Person>>((ref) {
  return const [
    Person(
      userId: 'aria@point.local',
      displayName: 'Aria',
      presence: PresenceState.live,
      subtitle: 'Sharing with you',
      distanceLabel: '0.4 mi',
      lat: 38.6272,
      lon: -90.1990,
    ),
    Person(
      userId: 'jesse@point.local',
      displayName: 'Jesse',
      presence: PresenceState.away,
      subtitle: 'Away · 2.1 mi',
      distanceLabel: '2.1 mi',
      lat: 38.6350,
      lon: -90.2100,
    ),
    Person(
      userId: 'mom@point.local',
      displayName: 'Mom',
      presence: PresenceState.stale,
      subtitle: 'Last seen 2h ago',
      lat: 38.6200,
      lon: -90.1850,
    ),
    Person(
      userId: 'dex@point.local',
      displayName: 'Dex',
      presence: PresenceState.ghosted,
      subtitle: 'Hidden · ghosting',
    ),
    Person(
      userId: 'sam@point.local',
      displayName: 'Sam',
      presence: PresenceState.live,
      subtitle: 'Sharing with you',
      distanceLabel: '5.0 mi',
      lat: 38.6400,
      lon: -90.1700,
    ),
  ];
});
