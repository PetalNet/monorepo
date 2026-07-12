import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/people/people_controller.dart';
import 'package:point_app/features/relay/relay_controller.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/theme/presence_tokens.dart';

/// After this long without a fresh fix, a person reads as DARK — the honest
/// interpretation of "no location is leaving their device" (ghost, dead phone,
/// or no signal are indistinguishable, by design). Their frozen last-known
/// position + "dark since" is shown; they stop plotting as a live pin.
const darkAfter = Duration(minutes: 3);

/// A short "how long ago" label: `now`, `4m`, `2h`, `3d`.
String relativeSince(int epochMillis, {DateTime? now}) {
  final then = DateTime.fromMillisecondsSinceEpoch(epochMillis);
  final delta = (now ?? DateTime.now()).difference(then);
  if (delta.inSeconds < 45) return 'now';
  if (delta.inMinutes < 60) return '${delta.inMinutes}m';
  if (delta.inHours < 24) return '${delta.inHours}h';
  return '${delta.inDays}d';
}

/// Local wall-clock `HH:MM` (24h, tabular) for a "dark since" line.
String clockHm(int epochMillis) {
  final t = DateTime.fromMillisecondsSinceEpoch(epochMillis);
  final h = t.hour.toString().padLeft(2, '0');
  final m = t.minute.toString().padLeft(2, '0');
  return '$h:$m';
}

/// A 30-second heartbeat so staleness (→ dark) and relative-time labels
/// re-evaluate even when no new fixes are arriving (the whole point when a peer
/// has gone dark and their stream has stopped).
final presenceClockProvider = StreamProvider<DateTime>(
  (ref) => Stream<DateTime>.periodic(
    const Duration(seconds: 30),
    (_) => DateTime.now(),
  ),
);

/// Merge a [Person] with their latest live decrypted [PeerFix], classifying
/// presence by freshness:
/// - fresh fix ⇒ `live`, located, status line (federated `@server` kept quiet);
/// - stale fix (older than [darkAfter]) ⇒ `stale` = DARK: frozen last-known
///   coordinate retained but "Dark since HH:MM"; the map won't plot them live;
/// - no fix ⇒ unchanged (accepted-but-not-yet-located, or long dark).
Person mergePresence(Person p, PeerFix? fix, {String? selfDomain, DateTime? now}) {
  if (fix == null) return p;
  final lat = (fix.data['lat'] as num?)?.toDouble();
  final lon = (fix.data['lon'] as num?)?.toDouble();
  final ts = (fix.data['timestamp'] as num?)?.toInt();
  if (lat == null || lon == null) return p;
  final at = now ?? DateTime.now();
  final dark = ts != null &&
      at.difference(DateTime.fromMillisecondsSinceEpoch(ts)) > darkAfter;
  final domain = p.userId.contains('@') ? p.userId.split('@').last : null;
  final federated = domain != null && selfDomain != null && domain != selfDomain;
  final String subtitle;
  if (dark) {
    subtitle = 'Dark since ${clockHm(ts)}';
  } else {
    final ago = ts != null ? relativeSince(ts, now: at) : 'now';
    subtitle = federated ? '${p.userId} · $ago' : 'Sharing · $ago';
  }
  return Person(
    userId: p.userId,
    displayName: p.displayName,
    presence: dark ? PresenceState.stale : PresenceState.live,
    subtitle: subtitle,
    distanceLabel: p.distanceLabel,
    lat: lat,
    lon: lon,
  );
}

/// The accepted people, each merged with their live presence + the freshness
/// clock. One merge feeds both the People list and the Map.
final peopleWithPresenceProvider = Provider<List<Person>>((ref) {
  final people = ref.watch(peopleControllerProvider).value ?? const <Person>[];
  final live = ref.watch(livePresenceProvider);
  final now = ref.watch(presenceClockProvider).value ?? DateTime.now();
  final self = ref.watch(authControllerProvider).value?.userId;
  final selfDomain =
      self != null && self.contains('@') ? self.split('@').last : null;
  return [
    for (final p in people)
      mergePresence(p, live[p.userId], selfDomain: selfDomain, now: now),
  ];
});
