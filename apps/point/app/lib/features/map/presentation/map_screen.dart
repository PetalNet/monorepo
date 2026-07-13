import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:latlong2/latlong.dart';
import 'package:point_app/app/point_app.dart';
import 'package:point_app/app/routes.dart';
import 'package:point_app/features/location/self_location_provider.dart';
import 'package:point_app/features/map/map_tiles.dart';
import 'package:point_app/features/map/presentation/person_map_sheet.dart';
import 'package:point_app/features/map/presentation/presence_marker.dart';
import 'package:point_app/features/map/presentation/self_marker.dart';
import 'package:point_app/features/people/people_presence.dart';
import 'package:point_app/features/people/temp_shares_controller.dart';
import 'package:point_app/features/relay/relay_controller.dart';
import 'package:point_app/features/settings/app_settings.dart';
import 'package:point_app/features/settings/haptics.dart';
import 'package:point_app/features/settings/settings_controller.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/theme/presence_tokens.dart';
import 'package:point_app/theme/theme_x.dart';

/// Map + presence (spec 07): a monochrome basemap centered on YOU, all active
/// sharers' last-known markers, a "recenter on me" FAB, and a go-dark entry.
/// People without any location remain in People without a fabricated marker.
/// Only the marker layer rebuilds on presence change.
class MapScreen extends ConsumerStatefulWidget {
  const MapScreen({super.key});

  static const _fallbackCenter = LatLng(38.627, -90.199);
  static const _neighborhoodZoom = 15.0;

  @override
  ConsumerState<MapScreen> createState() => _MapScreenState();
}

@immutable
class MapFollowState {
  const MapFollowState.idle() : userId = null;
  const MapFollowState.following(this.userId);

  final String? userId;

  bool get isFollowing => userId != null;

  MapFollowState follow(String userId) => MapFollowState.following(userId);
  MapFollowState onUserGesture() => const MapFollowState.idle();

  @override
  bool operator ==(Object other) =>
      other is MapFollowState && other.userId == userId;

  @override
  int get hashCode => userId.hashCode;
}

class _MapScreenState extends ConsumerState<MapScreen>
    with SingleTickerProviderStateMixin {
  final _mapController = MapController();
  late final AnimationController _cameraAnimation;
  bool _centeredOnSelf = false;
  bool _mapReady = false;
  MapFollowState _follow = const MapFollowState.idle();
  LatLng? _cameraFrom;
  LatLng? _cameraTarget;
  double _cameraZoomFrom = MapScreen._neighborhoodZoom;
  double _cameraZoomTarget = MapScreen._neighborhoodZoom;
  ({LatLng point, String? followUserId})? _pendingMove;

  @override
  void initState() {
    super.initState();
    _cameraAnimation = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 240),
    )..addListener(_onCameraTick);
  }

  @override
  void dispose() {
    _cameraAnimation.dispose();
    _mapController.dispose();
    super.dispose();
  }

  bool get _reducedMotion {
    final preference = ref.read(settingsProvider).motion;
    return preference == MotionPreference.reduced ||
        (preference == MotionPreference.system &&
            MediaQuery.disableAnimationsOf(context));
  }

  void _onCameraTick() {
    final from = _cameraFrom;
    final target = _cameraTarget;
    if (!_mapReady || from == null || target == null) return;
    final t = Curves.easeOutQuart.transform(_cameraAnimation.value);
    final point = MapLatLngTween(begin: from, end: target).lerp(t);
    final zoom = _cameraZoomFrom + (_cameraZoomTarget - _cameraZoomFrom) * t;
    _mapController.move(point, zoom);
  }

  void _moveTo(LatLng point, {String? followUserId}) {
    setState(() {
      _follow = followUserId == null
          ? const MapFollowState.idle()
          : _follow.follow(followUserId);
    });
    if (!_mapReady) {
      _pendingMove = (point: point, followUserId: followUserId);
      return;
    }
    if (_reducedMotion) {
      _cameraAnimation.stop();
      _mapController.move(point, MapScreen._neighborhoodZoom);
      return;
    }
    _cameraFrom = _mapController.camera.center;
    _cameraTarget = point;
    _cameraZoomFrom = _mapController.camera.zoom;
    _cameraZoomTarget = MapScreen._neighborhoodZoom;
    unawaited(_cameraAnimation.forward(from: 0));
  }

  void _onMapPositionChanged(MapCamera _, bool hasGesture) {
    if (!hasGesture) return;
    _cameraAnimation.stop();
    if (!_follow.isFollowing) return;
    setState(() => _follow = _follow.onUserGesture());
  }

  void _onMarkerPosition(String userId, LatLng point) {
    if (_follow.userId != userId || _cameraAnimation.isAnimating) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_mapReady || _follow.userId != userId) return;
      _cameraAnimation.stop();
      _mapController.move(point, _mapController.camera.zoom);
    });
  }

  void _onMapReady() {
    _mapReady = true;
    final pending = _pendingMove;
    _pendingMove = null;
    if (pending == null) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _moveTo(pending.point, followUserId: pending.followUserId);
    });
  }

  @override
  Widget build(BuildContext context) {
    final self = ref.watch(selfLocationProvider).value;
    final selfPoint = self != null ? LatLng(self.lat, self.lon) : null;
    final motions = ref.watch(livePresenceProvider);
    final motionPreference = ref.watch(
      settingsProvider.select((settings) => settings.motion),
    );
    final timeFormat = ref.watch(
      settingsProvider.select((settings) => settings.timeFormat),
    );
    final reducedMotion =
        motionPreference == MotionPreference.reduced ||
        (motionPreference == MotionPreference.system &&
            MediaQuery.disableAnimationsOf(context));

    // Start the camera on YOU the first time a fix lands, then never yank it.
    ref.listen(selfLocationProvider, (_, next) {
      final fix = next.value;
      if (fix != null && !_centeredOnSelf) {
        _centeredOnSelf = true;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) _moveTo(LatLng(fix.lat, fix.lon));
        });
      }
    });

    // A real last-known coordinate remains useful indefinitely. Freshness is
    // carried by the marker's form + status; only people with no fix ever stay
    // off-map, and relationship teardown still removes cached locations.
    final located = [
      ...ref.watch(peopleWithPresenceProvider),
      ...ref.watch(incomingTempPeopleProvider),
    ].where((p) => p.hasLocation).map(_neutralMapPresence).toList();

    return Scaffold(
      appBar: AppBar(
        title: Row(
          children: [
            const BrandDot(),
            SizedBox(width: context.space.sm),
            const Text('Point'),
          ],
        ),
        actions: [
          const ViewPeopleListButton(),
          IconButton(
            icon: const Icon(Icons.visibility_off_outlined),
            tooltip: 'Go dark',
            onPressed: () => context.push(const GhostRoute()),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.small(
        heroTag: 'recenter',
        tooltip: 'Recenter on me',
        onPressed: selfPoint == null
            ? null
            : () {
                Haptics.selection(ref);
                _moveTo(selfPoint);
              },
        child: const Icon(Icons.my_location),
      ),
      body: Stack(
        children: [
          // Dark on-brand fill behind the tiles so the basemap reads monochrome
          // even before tiles load (and in the offline render harness).
          Positioned.fill(child: ColoredBox(color: context.colors.surface)),
          FlutterMap(
            mapController: _mapController,
            options: MapOptions(
              initialCenter: selfPoint ?? MapScreen._fallbackCenter,
              initialZoom: MapScreen._neighborhoodZoom,
              interactionOptions: const InteractionOptions(
                flags: InteractiveFlag.all & ~InteractiveFlag.rotate,
              ),
              onMapReady: _onMapReady,
              onPositionChanged: _onMapPositionChanged,
            ),
            children: [
              _BasemapLayer(),
              _PeopleMarkers(
                people: located,
                motions: motions,
                timeFormat: timeFormat,
                reducedMotion: reducedMotion,
                onFocus: (person) {
                  Haptics.selection(ref);
                  _moveTo(
                    LatLng(person.lat!, person.lon!),
                    followUserId: person.userId,
                  );
                },
                onPosition: _onMarkerPosition,
              ),
              if (selfPoint != null) _SelfMarkerLayer(point: selfPoint),
            ],
          ),
          const MapAvailabilityOverlay(),
          Positioned(
            top: context.space.sm,
            left: context.space.sm,
            right: context.space.sm,
            child: Column(
              children: [
                const RelayHealthBanner(),
                if (_follow.isFollowing)
                  Padding(
                    padding: EdgeInsets.only(top: context.space.sm),
                    child: _FollowBadge(
                      name: located
                          .where((person) => person.userId == _follow.userId)
                          .firstOrNull
                          ?.displayName,
                      onStop: () =>
                          setState(() => _follow = _follow.onUserGesture()),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Defense in depth for ghost deniability: even if a future source supplies
/// the internal ghosted form, a shared person's map marker stays identical to
/// every other neutral dark/stale cause.
Person _neutralMapPresence(Person person) {
  if (person.presence != PresenceState.ghosted) return person;
  return Person(
    userId: person.userId,
    displayName: person.displayName,
    presence: PresenceState.stale,
    subtitle: 'Last place · Dark',
    distanceLabel: person.distanceLabel,
    lat: person.lat,
    lon: person.lon,
    darkSinceAt: person.darkSinceAt,
    profileVersion: person.profileVersion,
    rekeyedAt: person.rekeyedAt,
    shareSince: person.shareSince,
  );
}

/// Honest map-discovery state shown above the privacy-preserving blank tile
/// layer. The copy intentionally reveals no server URL or transport detail.
class MapAvailabilityOverlay extends ConsumerWidget {
  const MapAvailabilityOverlay({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tileInfo = ref.watch(serverTileInfoProvider);
    if (!tileInfo.isLoading && !tileInfo.hasError && tileInfo.hasValue) {
      return const SizedBox.shrink();
    }

    final failed = tileInfo.hasError;
    return Positioned.fill(
      child: ColoredBox(
        color: context.colors.surface.withValues(alpha: 0.92),
        child: Center(
          child: Semantics(
            liveRegion: true,
            container: true,
            label: failed ? 'Map unavailable' : 'Loading map',
            child: Container(
              constraints: const BoxConstraints(maxWidth: 320),
              margin: EdgeInsets.all(context.space.xl),
              padding: EdgeInsets.all(context.space.xl),
              decoration: BoxDecoration(
                color: context.colors.surfaceContainer,
                borderRadius: context.radii.brLg,
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    failed ? Icons.map_outlined : Icons.layers_outlined,
                    size: 32,
                  ),
                  SizedBox(height: context.space.md),
                  Text(
                    failed ? 'Map unavailable' : 'Loading map',
                    style: context.text.titleMedium,
                  ),
                  if (failed) ...[
                    SizedBox(height: context.space.sm),
                    Text(
                      'Point could not discover a private map source.',
                      textAlign: TextAlign.center,
                      style: context.text.bodyMedium?.copyWith(
                        color: context.colors.onSurfaceVariant,
                      ),
                    ),
                    SizedBox(height: context.space.lg),
                    FilledButton.icon(
                      onPressed: () => ref.invalidate(serverTileInfoProvider),
                      icon: const Icon(Icons.refresh),
                      label: const Text('Retry'),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A non-map route to the same people represented by map markers.
///
/// Keeping this action in the map chrome makes the alternative discoverable
/// to screen-reader and switch-access users without requiring map gestures.
class ViewPeopleListButton extends StatelessWidget {
  const ViewPeopleListButton({super.key});

  static const _peopleBranchIndex = 1;

  @override
  Widget build(BuildContext context) {
    return IconButton(
      icon: const Icon(Icons.people_alt_outlined),
      tooltip: 'View people list',
      onPressed: () => context.shell().switchTo(_peopleBranchIndex),
    );
  }
}

/// The basemap, resolved from the Privacy map-provider choice against what
/// the connected server offers (Wave C). Watching the source means switching
/// the setting re-renders the map live.
class _BasemapLayer extends ConsumerWidget {
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final source = ref.watch(tileSourceProvider);
    // Null = the server's tile endpoints haven't resolved yet: render nothing
    // (the dark surface behind shows) rather than request tiles from a public
    // CDN before we know the private tier's real source.
    if (source == null) return const SizedBox.shrink();
    return TileLayer(
      key: ValueKey(source.urlTemplate),
      urlTemplate: source.urlTemplate,
      subdomains: source.subdomains,
      retinaMode: source.retina && RetinaMode.isHighDensity(context),
      userAgentPackageName: 'dev.petalcat.point',
      // flutter_map injects its User-Agent into this map: hand it a mutable
      // copy, never the const from the provider.
      tileProvider: NetworkTileProvider(headers: Map.of(source.headers)),
    );
  }
}

/// The self-marker layer — a fixed-size, center-anchored photo-dot on YOU.
class _SelfMarkerLayer extends ConsumerWidget {
  const _SelfMarkerLayer({required this.point});
  final LatLng point;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final name = ref.watch(authControllerProvider).value?.displayName ?? 'You';
    return MarkerLayer(
      markers: [
        Marker(
          point: point,
          width: SelfMarker.size,
          height: SelfMarker.size,
          child: SelfMarker(name: name),
        ),
      ],
    );
  }
}

/// The sharers' marker layer — isolated so only it rebuilds on presence change.
/// Tapping a marker opens the compact person sheet.
class _PeopleMarkers extends StatefulWidget {
  const _PeopleMarkers({
    required this.people,
    required this.motions,
    required this.timeFormat,
    required this.reducedMotion,
    required this.onFocus,
    required this.onPosition,
  });
  final List<Person> people;
  final Map<String, PeerMarkerMotion> motions;
  final TimeFormat timeFormat;
  final bool reducedMotion;
  final void Function(Person) onFocus;
  final void Function(String, LatLng) onPosition;

  @override
  State<_PeopleMarkers> createState() => _PeopleMarkersState();
}

class _PeopleMarkersState extends State<_PeopleMarkers>
    with TickerProviderStateMixin {
  static const _transitionDuration = Duration(milliseconds: 180);
  final _entries = <String, _MarkerEntry>{};

  @override
  void initState() {
    super.initState();
    for (final person in widget.people) {
      _entries[person.userId] = _MarkerEntry(
        person: person,
        controller: AnimationController(
          vsync: this,
          duration: _transitionDuration,
          value: 1,
        ),
      );
    }
  }

  @override
  void didUpdateWidget(_PeopleMarkers oldWidget) {
    super.didUpdateWidget(oldWidget);
    _syncRoster();
  }

  void _syncRoster() {
    final next = {for (final person in widget.people) person.userId: person};

    if (widget.reducedMotion) {
      for (final entry in _entries.values.toList()) {
        final person = next[entry.person.userId];
        if (person == null) {
          _entries.remove(entry.person.userId);
          entry.exiting = false;
          entry.controller.dispose();
        } else {
          entry
            ..person = person
            ..exiting = false
            ..controller.value = 1;
        }
      }
      for (final person in widget.people) {
        _entries.putIfAbsent(
          person.userId,
          () => _MarkerEntry(
            person: person,
            controller: AnimationController(
              vsync: this,
              duration: _transitionDuration,
              value: 1,
            ),
          ),
        );
      }
      return;
    }

    for (final person in widget.people) {
      final existing = _entries[person.userId];
      if (existing != null) {
        existing
          ..person = person
          ..exiting = false;
        if (existing.controller.value < 1) {
          unawaited(existing.controller.forward());
        }
        continue;
      }
      final controller = AnimationController(
        vsync: this,
        duration: _transitionDuration,
        value: 0,
      );
      _entries[person.userId] = _MarkerEntry(
        person: person,
        controller: controller,
      );
      unawaited(controller.forward());
    }

    for (final entry in _entries.values.toList()) {
      if (next.containsKey(entry.person.userId) || entry.exiting) continue;
      entry
        ..person = _staleVersion(entry.person)
        ..exiting = true;
      entry.controller.reverse().whenCompleteOrCancel(() {
        if (!mounted || !entry.exiting) return;
        setState(() {
          _entries.remove(entry.person.userId);
          entry.controller.dispose();
        });
      });
    }
  }

  Person _staleVersion(Person person) => Person(
    userId: person.userId,
    displayName: person.displayName,
    presence: PresenceState.stale,
    subtitle: person.subtitle,
    distanceLabel: person.distanceLabel,
    lat: person.lat,
    lon: person.lon,
    darkSinceAt: person.darkSinceAt,
    profileVersion: person.profileVersion,
    rekeyedAt: person.rekeyedAt,
    shareSince: person.shareSince,
  );

  @override
  void dispose() {
    for (final entry in _entries.values) {
      entry.exiting = false;
      entry.controller.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        for (final entry in _entries.values)
          _AnimatedPersonMarkerLayer(
            key: ValueKey('marker-transition-${entry.person.userId}'),
            person: entry.person,
            motion: widget.motions[entry.person.userId],
            timeFormat: widget.timeFormat,
            visibility: entry.controller,
            exiting: entry.exiting,
            reducedMotion: widget.reducedMotion,
            onPosition: widget.onPosition,
            onTap: () => PersonMapSheet.show(
              context,
              person: entry.person,
              onFocus: () => widget.onFocus(entry.person),
              onOpenDetail: () =>
                  context.push(PersonDetailRoute(entry.person.userId)),
            ),
          ),
      ],
    );
  }
}

class _MarkerEntry {
  _MarkerEntry({required this.person, required this.controller});

  Person person;
  final AnimationController controller;
  bool exiting = false;
}

class _AnimatedPersonMarkerLayer extends StatelessWidget {
  const _AnimatedPersonMarkerLayer({
    required this.person,
    required this.motion,
    required this.timeFormat,
    required this.reducedMotion,
    required this.onPosition,
    required this.onTap,
    this.exiting = false,
    this.visibility,
    super.key,
  });

  final Person person;
  final PeerMarkerMotion? motion;
  final TimeFormat timeFormat;
  final Animation<double>? visibility;
  final bool exiting;
  final bool reducedMotion;
  final void Function(String, LatLng) onPosition;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final target = LatLng(person.lat!, person.lon!);
    final previous = motion?.previous;
    final begin = previous?.lat == null || previous?.lon == null
        ? target
        : LatLng(previous!.lat!, previous.lon!);
    Widget marker = IgnorePointer(
      ignoring: exiting,
      child: ExcludeSemantics(
        excluding: exiting,
        child: PresenceMarker(
          person: person,
          timeFormat: timeFormat,
          onTap: onTap,
        ),
      ),
    );
    final visibility = this.visibility;
    if (visibility != null) {
      final eased = CurvedAnimation(
        parent: visibility,
        curve: Curves.easeOutQuart,
      );
      marker = FadeTransition(
        opacity: eased,
        child: ScaleTransition(
          scale: Tween<double>(begin: 0.92, end: 1).animate(eased),
          child: marker,
        ),
      );
    }
    return TweenAnimationBuilder<LatLng>(
      tween: MapLatLngTween(begin: begin, end: target),
      duration: motion?.duration(reducedMotion: reducedMotion) ?? Duration.zero,
      curve: Curves.easeOutQuart,
      builder: (context, point, child) {
        onPosition(person.userId, point);
        return MarkerLayer(
          markers: [
            Marker(
              point: point,
              width: 144,
              height: 92,
              alignment: Alignment.topCenter,
              child: child!,
            ),
          ],
        );
      },
      child: marker,
    );
  }
}

class MapLatLngTween extends Tween<LatLng> {
  MapLatLngTween({required super.begin, required super.end});

  @override
  LatLng lerp(double t) {
    final start = begin!;
    final finish = end!;
    final longitudeDelta =
        (finish.longitude - start.longitude + 540) % 360 - 180;
    final longitude = start.longitude + longitudeDelta * t;
    return LatLng(
      start.latitude + (finish.latitude - start.latitude) * t,
      (longitude + 540) % 360 - 180,
    );
  }
}

class _FollowBadge extends StatelessWidget {
  const _FollowBadge({required this.name, required this.onStop});

  final String? name;
  final VoidCallback onStop;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Material(
        color: context.colors.inverseSurface,
        borderRadius: BorderRadius.circular(context.radii.full),
        child: InkWell(
          onTap: onStop,
          borderRadius: BorderRadius.circular(context.radii.full),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 48),
            child: Padding(
              padding: EdgeInsets.symmetric(horizontal: context.space.md),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.near_me, color: context.colors.onInverseSurface),
                  SizedBox(width: context.space.sm),
                  Text(
                    name == null ? 'Following' : 'Following $name',
                    style: context.text.labelLarge?.copyWith(
                      color: context.colors.onInverseSurface,
                    ),
                  ),
                  SizedBox(width: context.space.sm),
                  Icon(Icons.close, color: context.colors.onInverseSurface),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
