import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/people/people_controller.dart';
import 'package:point_app/features/relay/relay_controller.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/theme/presence_tokens.dart';

/// A short "how long ago" label from an epoch-millis timestamp: `now`, `4m`,
/// `2h`, `3d`. Used for a person's last-updated line (mono figures).
String relativeSince(int epochMillis, {DateTime? now}) {
  final then = DateTime.fromMillisecondsSinceEpoch(epochMillis);
  final delta = (now ?? DateTime.now()).difference(then);
  if (delta.inSeconds < 45) return 'now';
  if (delta.inMinutes < 60) return '${delta.inMinutes}m';
  if (delta.inHours < 24) return '${delta.inHours}h';
  return '${delta.inDays}d';
}

/// Merge a [Person] (from the accepted-shares list) with their latest live
/// decrypted [PeerFix]: a fix present ⇒ they're `live` with fresh coordinates
/// and a status line; no fix yet ⇒ they stay listed but locationless (an
/// accepted-but-not-yet-located, or dark, person — plotted by neither).
///
/// A cross-server person keeps their `@server` handle visible in the status
/// line (federation is "visible-but-quiet"); a same-server person shows the
/// plain "Sharing · 4m".
Person mergePresence(Person p, PeerFix? fix, {String? selfDomain, DateTime? now}) {
  if (fix == null) return p;
  final lat = (fix.data['lat'] as num?)?.toDouble();
  final lon = (fix.data['lon'] as num?)?.toDouble();
  final ts = (fix.data['timestamp'] as num?)?.toInt();
  if (lat == null || lon == null) return p;
  final ago = ts != null ? relativeSince(ts, now: now) : 'now';
  final domain = p.userId.contains('@') ? p.userId.split('@').last : null;
  final federated = domain != null && selfDomain != null && domain != selfDomain;
  return Person(
    userId: p.userId,
    displayName: p.displayName,
    presence: PresenceState.live,
    subtitle: federated ? '${p.userId} · $ago' : 'Sharing · $ago',
    distanceLabel: p.distanceLabel,
    lat: lat,
    lon: lon,
  );
}

/// The accepted people, each merged with their live presence. Rebuilds when the
/// shares list or any peer fix changes. Both the People list and the Map read
/// this so there is one merge, not two.
final peopleWithPresenceProvider = Provider<List<Person>>((ref) {
  final people = ref.watch(peopleControllerProvider).value ?? const <Person>[];
  final live = ref.watch(livePresenceProvider);
  final self = ref.watch(authControllerProvider).value?.userId;
  final selfDomain =
      self != null && self.contains('@') ? self.split('@').last : null;
  return [
    for (final p in people) mergePresence(p, live[p.userId], selfDomain: selfDomain),
  ];
});
