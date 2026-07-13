import 'package:geolocator/geolocator.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/location/data/location_service.dart';
import 'package:point_app/features/location/self_location_provider.dart';
import 'package:point_app/features/people/people_controller.dart';
import 'package:point_app/features/relay/relay_controller.dart';
import 'package:point_app/features/settings/app_settings.dart';
import 'package:point_app/features/settings/settings_controller.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/theme/presence_tokens.dart';

/// After this long without a fresh fix, a person reads as DARK — the honest
/// interpretation of "no location is leaving their device" (ghost, dead phone,
/// or no signal are indistinguishable, by design). Their frozen last-known
/// position + "dark since" remains visible on both Map and People.
const darkAfter = Duration(minutes: 3);

/// How confidently the client can describe a peer fix at the current time.
enum FixFreshness { current, recent, stale, uncertain }

/// Derive freshness from the signed sample clock. A small future skew is
/// tolerated; a larger one is called uncertain instead of overstating it as
/// an update that happened "now".
FixFreshness fixFreshness(int? epochMillis, {DateTime? now}) {
  if (epochMillis == null) return FixFreshness.uncertain;
  final delta = (now ?? DateTime.now()).difference(
    DateTime.fromMillisecondsSinceEpoch(epochMillis),
  );
  if (delta < const Duration(minutes: -1)) return FixFreshness.uncertain;
  if (delta < const Duration(seconds: 45)) return FixFreshness.current;
  if (delta <= darkAfter) return FixFreshness.recent;
  return FixFreshness.stale;
}

/// A short "how long ago" label: `now`, `4m`, `2h`, `3d`.
String relativeSince(int epochMillis, {DateTime? now}) {
  final then = DateTime.fromMillisecondsSinceEpoch(epochMillis);
  final delta = (now ?? DateTime.now()).difference(then);
  if (delta < const Duration(minutes: -1)) return 'time uncertain';
  if (delta.inSeconds < 45) return 'now';
  if (delta.inMinutes < 60) return '${delta.inMinutes}m';
  if (delta.inHours < 24) return '${delta.inHours}h';
  return '${delta.inDays}d';
}

/// Human-scale horizontal precision. Invalid or absent values are omitted so
/// old payloads and platform failures never produce a misleading radius.
String? formatAccuracy(double? meters) {
  if (meters == null || !meters.isFinite || meters <= 0) return null;
  if (meters < 1) return '±<1 m';
  if (meters < 1000) return '±${meters.round()} m';
  return '±${(meters / 1000).toStringAsFixed(1)} km';
}

/// Local wall-clock time for a "dark since" line, honoring the clock-format
/// setting: `16:05` (24h, tabular) or `4:05 pm`.
String clockHm(int epochMillis, {TimeFormat format = TimeFormat.h24}) {
  final t = DateTime.fromMillisecondsSinceEpoch(epochMillis);
  final m = t.minute.toString().padLeft(2, '0');
  if (format == TimeFormat.h24) {
    return '${t.hour.toString().padLeft(2, '0')}:$m';
  }
  final h = t.hour % 12 == 0 ? 12 : t.hour % 12;
  final suffix = t.hour < 12 ? 'am' : 'pm';
  return '$h:$m $suffix';
}

/// A distance from you, in the units you chose. Short ranges keep a finer
/// grain (`420 ft` / `310 m`), long ones round.
String formatDistance(double meters, DistanceUnits units) {
  switch (units) {
    case DistanceUnits.miles:
      final mi = meters / 1609.344;
      if (mi < 0.095) return '${(meters * 3.28084).round()} ft';
      // 9.95+ would render '10.0': hand it to the whole-number branch.
      if (mi < 9.95) return '${mi.toStringAsFixed(1)} mi';
      return '${mi.round()} mi';
    case DistanceUnits.kilometers:
      if (meters < 950) return '${meters.round()} m';
      final km = meters / 1000;
      if (km < 9.95) return '${km.toStringAsFixed(1)} km';
      return '${km.round()} km';
  }
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

/// Merge a [Person] with server liveness and their latest decrypted [PeerFix].
/// The privacy-safe state table is:
/// - server offline ⇒ `stale` immediately, regardless of fix freshness;
/// - server online + no fix ⇒ `live` but locationless;
/// - fresh fix ⇒ `live`, located, status line (federated `@server` kept quiet);
/// - stale fix (older than [darkAfter]) ⇒ `stale` = DARK: frozen last-known
///   coordinate retained with "Dark since HH:MM" and a dark map marker;
/// - no server signal ⇒ fix freshness remains the conservative fallback.
Person mergePresence(
  Person p,
  PeerFix? fix, {
  PeerPresence? serverPresence,
  String? selfDomain,
  DateTime? now,
  TimeFormat timeFormat = TimeFormat.h24,
}) {
  final at = now ?? DateTime.now();
  final lat = (fix?.data['lat'] as num?)?.toDouble();
  final lon = (fix?.data['lon'] as num?)?.toDouble();
  if (fix == null || lat == null || lon == null) {
    if (serverPresence == null) return p;
    final online = serverPresence.online;
    return Person(
      userId: p.userId,
      displayName: p.displayName,
      presence: online ? PresenceState.live : PresenceState.stale,
      subtitle: online
          ? 'Online · Waiting for location'
          : 'Dark since ${clockHm(serverPresence.observedAt.millisecondsSinceEpoch, format: timeFormat)}',
      distanceLabel: p.distanceLabel,
    );
  }
  final ts = fix.timestamp;
  final freshness = fixFreshness(ts, now: at);
  final staleFix = freshness == FixFreshness.stale;
  final uncertainFix = freshness == FixFreshness.uncertain;
  final offline = serverPresence?.online == false;
  final dark = offline || staleFix;
  final darkSinceAt = dark
      ? offline
            ? serverPresence!.observedAt.millisecondsSinceEpoch
            : ts!
      : null;
  final domain = p.userId.contains('@') ? p.userId.split('@').last : null;
  final federated =
      domain != null && selfDomain != null && domain != selfDomain;
  final String subtitle;
  if (dark) {
    final precision = formatAccuracy(fix.accuracy);
    subtitle = [
      'Last place',
      'Dark since ${clockHm(darkSinceAt!, format: timeFormat)}',
      if (precision != null) precision,
    ].join(' · ');
  } else if (uncertainFix) {
    final precision = formatAccuracy(fix.accuracy);
    subtitle = [
      'Last place',
      'Update time uncertain',
      if (precision != null) precision,
    ].join(' · ');
  } else {
    final ago = ts != null ? relativeSince(ts, now: at) : 'time uncertain';
    final precision = formatAccuracy(fix.accuracy);
    subtitle = [
      if (federated) p.userId else 'Sharing',
      if (precision != null) precision,
      ago,
    ].join(' · ');
  }
  return Person(
    userId: p.userId,
    displayName: p.displayName,
    presence: dark
        ? PresenceState.stale
        : uncertainFix
        ? PresenceState.away
        : PresenceState.live,
    subtitle: subtitle,
    distanceLabel: p.distanceLabel,
    lat: lat,
    lon: lon,
    darkSinceAt: darkSinceAt,
  );
}

/// The accepted people, each merged with their live presence + the freshness
/// clock. One merge feeds both the People list and the Map.
final peopleWithPresenceProvider = Provider<List<Person>>((ref) {
  final people = ref.watch(peopleControllerProvider).value ?? const <Person>[];
  final live = ref.watch(livePresenceProvider);
  final serverPresence = ref.watch(peerPresenceProvider);
  final now = ref.watch(presenceClockProvider).value ?? DateTime.now();
  final self = ref.watch(authControllerProvider).value?.userId;
  final selfDomain = self != null && self.contains('@')
      ? self.split('@').last
      : null;
  final units = ref.watch(settingsProvider.select((s) => s.units));
  final timeFormat = ref.watch(settingsProvider.select((s) => s.timeFormat));
  final selfFix = ref.watch(selfLocationProvider).value;
  return [
    for (final p in people)
      _withDistance(
        mergePresence(
          p,
          live[p.userId]?.target,
          serverPresence: serverPresence[p.userId],
          selfDomain: selfDomain,
          now: now,
          timeFormat: timeFormat,
        ),
        selfFix,
        units,
      ),
  ];
});

/// Attach "how far from me" once a person AND self are both located. Pure
/// presentation: the label re-derives per settings change.
Person _withDistance(Person p, Fix? selfFix, DistanceUnits units) {
  if (selfFix == null || !p.hasLocation) return p;
  final meters = Geolocator.distanceBetween(
    selfFix.lat,
    selfFix.lon,
    p.lat!,
    p.lon!,
  );
  return Person(
    userId: p.userId,
    displayName: p.displayName,
    presence: p.presence,
    subtitle: p.subtitle,
    distanceLabel: formatDistance(meters, units),
    lat: p.lat,
    lon: p.lon,
    darkSinceAt: p.darkSinceAt,
  );
}
