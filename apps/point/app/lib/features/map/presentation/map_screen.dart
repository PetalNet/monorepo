import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:latlong2/latlong.dart';
import 'package:point_app/app/app_recovery_coordinator.dart';
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
            const Flexible(
              child: Text(
                'Point',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
            SizedBox(width: context.space.sm),
            const Expanded(child: RelayHealthIndicator()),
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
                selectedUserId: _follow.userId,
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
          if (_follow.isFollowing)
            Positioned(
              top: context.space.sm,
              left: context.space.sm,
              right: context.space.sm,
              child: _FollowBadge(
                name: located
                    .where((person) => person.userId == _follow.userId)
                    .firstOrNull
                    ?.displayName,
                onStop: () => setState(() => _follow = _follow.onUserGesture()),
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

/// Compact map-discovery state above the privacy-preserving canvas. It never
/// blocks cached people/self markers, and its copy reveals no server detail.
class MapAvailabilityOverlay extends ConsumerWidget {
  const MapAvailabilityOverlay({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tileInfo = ref.watch(serverTileInfoProvider);
    final hasUsableSource = ref.watch(tileSourceProvider) != null;
    if (hasUsableSource ||
        (!tileInfo.isLoading && !tileInfo.hasError && tileInfo.hasValue)) {
      return const SizedBox.shrink();
    }

    final failed = tileInfo.hasError;
    return _MapAvailabilityBanner(
      failed: failed,
      onRetry: () => ref.read(appRecoveryCoordinatorProvider).retryMapNow(),
    );
  }
}

class _MapAvailabilityBanner extends StatelessWidget {
  const _MapAvailabilityBanner({
    required this.failed,
    required this.onRetry,
  });

  final bool failed;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Positioned(
      left: context.space.sm,
      right: context.space.sm,
      bottom: context.space.sm,
      child: SafeArea(
        top: false,
        child: Semantics(
          liveRegion: true,
          container: true,
          label: failed
              ? 'Map unavailable. Retrying automatically.'
              : 'Finding private map source.',
          child: Material(
            color: context.colors.surfaceContainer,
            shape: RoundedRectangleBorder(borderRadius: context.radii.brMd),
            child: Padding(
              padding: EdgeInsets.symmetric(
                horizontal: context.space.lg,
                vertical: context.space.md,
              ),
              child: Row(
                children: [
                  Icon(failed ? Icons.map_outlined : Icons.layers_outlined),
                  SizedBox(width: context.space.md),
                  Expanded(
                    child: _MapAvailabilityMessage(failed: failed),
                  ),
                  if (failed)
                    TextButton(
                      onPressed: onRetry,
                      child: const Text('Retry now'),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _MapAvailabilityMessage extends StatelessWidget {
  const _MapAvailabilityMessage({required this.failed});

  final bool failed;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          failed ? 'Map unavailable' : 'Finding private map…',
          style: context.text.titleSmall,
        ),
        Text(
          failed
              ? 'Retrying automatically'
              : 'People stay available while Point connects',
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          style: context.text.bodySmall?.copyWith(
            color: context.colors.onSurfaceVariant,
          ),
        ),
      ],
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
    required this.selectedUserId,
    required this.onFocus,
    required this.onPosition,
  });
  final List<Person> people;
  final Map<String, PeerMarkerMotion> motions;
  final TimeFormat timeFormat;
  final bool reducedMotion;
  final String? selectedUserId;
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
    final camera = MapCamera.of(context);
    final layout = _MarkerLayout.resolve(
      entries: _entries.values.toList(),
      camera: camera,
      selectedUserId: widget.selectedUserId,
    );
    return Stack(
      children: [
        for (final cluster in layout.clusters)
          _PeopleClusterMarker(
            cluster: cluster,
            camera: camera,
            onTap: () => _openCluster(cluster, camera),
          ),
        for (final placement in layout.people)
          _AnimatedPersonMarkerLayer(
            key: ValueKey('marker-transition-${placement.entry.person.userId}'),
            person: placement.entry.person,
            motion: widget.motions[placement.entry.person.userId],
            timeFormat: widget.timeFormat,
            showLabel: placement.showLabel,
            visibility: placement.entry.controller,
            exiting: placement.entry.exiting,
            reducedMotion: widget.reducedMotion,
            onPosition: widget.onPosition,
            onTap: () => PersonMapSheet.show(
              context,
              person: placement.entry.person,
              onFocus: () => widget.onFocus(placement.entry.person),
              onOpenDetail: () => context.push(
                PersonDetailRoute(placement.entry.person.userId),
              ),
            ),
          ),
      ],
    );
  }

  void _openCluster(_MarkerCluster cluster, MapCamera camera) {
    if (camera.zoom < 18) {
      final center = cluster.center;
      MapController.of(context).move(center, math.min(camera.zoom + 2, 18));
      return;
    }
    unawaited(
      showModalBottomSheet<void>(
        context: context,
        builder: (sheetContext) => SafeArea(
          child: ListView.builder(
            shrinkWrap: true,
            padding: EdgeInsets.only(bottom: sheetContext.space.sm),
            itemCount: cluster.entries.length + 1,
            itemBuilder: (context, index) {
              if (index == 0) {
                return Padding(
                  padding: EdgeInsets.fromLTRB(
                    sheetContext.space.lg,
                    sheetContext.space.sm,
                    sheetContext.space.lg,
                    sheetContext.space.xs,
                  ),
                  child: Text(
                    'People here',
                    style: sheetContext.text.titleMedium,
                  ),
                );
              }
              final entry = cluster.entries[index - 1];
              return ListTile(
                leading: const Icon(Icons.person_outline),
                title: Text(entry.person.displayName),
                subtitle: Text(entry.person.subtitle),
                onTap: () {
                  Navigator.of(sheetContext).pop();
                  unawaited(
                    PersonMapSheet.show(
                      context,
                      person: entry.person,
                      onFocus: () => widget.onFocus(entry.person),
                      onOpenDetail: () => context.push(
                        PersonDetailRoute(entry.person.userId),
                      ),
                    ),
                  );
                },
              );
            },
          ),
        ),
      ),
    );
  }
}

class _MarkerLayout {
  const _MarkerLayout({required this.people, required this.clusters});

  factory _MarkerLayout.resolve({
    required List<_MarkerEntry> entries,
    required MapCamera camera,
    required String? selectedUserId,
  }) {
    final ordered = [...entries]
      ..sort((a, b) {
        final aPriority = _priority(a.person, selectedUserId);
        final bPriority = _priority(b.person, selectedUserId);
        return bPriority.compareTo(aPriority);
      });
    final pending = [...ordered];
    final people = <_PersonPlacement>[];
    final clusters = <_MarkerCluster>[];
    final labelBounds = <Rect>[];
    // Identity dots are 48dp tap targets. Clustering at anything below their
    // diameter would leave overlapping people visually and tappably ambiguous.
    const clusterDistance = 48.0;

    while (pending.isNotEmpty) {
      final seed = pending.removeAt(0);
      final seedPoint = _screenPoint(seed, camera);
      final neighbors = <_MarkerEntry>[seed];
      final isSelected = seed.person.userId == selectedUserId;
      if (!isSelected) {
        pending.removeWhere((candidate) {
          if ((_screenPoint(candidate, camera) - seedPoint).distance >
              clusterDistance) {
            return false;
          }
          neighbors.add(candidate);
          return true;
        });
      }
      if (neighbors.length > 1) {
        clusters.add(_MarkerCluster(entries: neighbors));
        continue;
      }

      final person = seed.person;
      final candidateBounds = Rect.fromCenter(
        center: seedPoint + const Offset(0, 68),
        width: 144,
        height: 48,
      );
      final selected = person.userId == selectedUserId;
      final separated = labelBounds.every(
        (occupied) => !occupied.inflate(4).overlaps(candidateBounds),
      );
      final showLabel = selected || separated;
      if (showLabel) labelBounds.add(candidateBounds);
      people.add(_PersonPlacement(entry: seed, showLabel: showLabel));
    }
    return _MarkerLayout(people: people, clusters: clusters);
  }

  final List<_PersonPlacement> people;
  final List<_MarkerCluster> clusters;

  static int _priority(Person person, String? selectedUserId) {
    if (person.userId == selectedUserId) return 3;
    if (person.presence == PresenceState.live) return 2;
    return 1;
  }

  static Offset _screenPoint(_MarkerEntry entry, MapCamera camera) =>
      camera.projectAtZoom(LatLng(entry.person.lat!, entry.person.lon!)) -
      camera.pixelOrigin;
}

class _PersonPlacement {
  const _PersonPlacement({required this.entry, required this.showLabel});
  final _MarkerEntry entry;
  final bool showLabel;
}

class _MarkerCluster {
  const _MarkerCluster({required this.entries});
  final List<_MarkerEntry> entries;

  LatLng get center {
    final latitude =
        entries.map((entry) => entry.person.lat!).reduce((a, b) => a + b) /
        entries.length;
    final longitudes = entries.map(
      (entry) => entry.person.lon! * math.pi / 180,
    );
    final sinSum = longitudes.map(math.sin).reduce((a, b) => a + b);
    final cosSum = longitudes.map(math.cos).reduce((a, b) => a + b);
    final longitude = math.atan2(sinSum, cosSum) * 180 / math.pi;
    return LatLng(latitude, longitude);
  }
}

class _PeopleClusterMarker extends StatelessWidget {
  const _PeopleClusterMarker({
    required this.cluster,
    required this.camera,
    required this.onTap,
  });

  final _MarkerCluster cluster;
  final MapCamera camera;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final count = cluster.entries.length;
    return MarkerLayer(
      markers: [
        Marker(
          point: cluster.center,
          width: 48,
          height: 48,
          child: Semantics(
            label: '$count people here',
            hint: camera.zoom < 18
                ? 'Zooms in to separate markers'
                : 'Shows people at this location',
            button: true,
            excludeSemantics: true,
            child: Material(
              color: context.colors.inverseSurface,
              shape: const CircleBorder(),
              child: InkWell(
                customBorder: const CircleBorder(),
                excludeFromSemantics: true,
                onTap: onTap,
                child: Center(
                  child: Text(
                    '$count',
                    style: context.text.labelLarge?.copyWith(
                      color: context.colors.onInverseSurface,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
              ),
            ),
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
    required this.showLabel,
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
  final bool showLabel;
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
          showLabel: showLabel,
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
              width: showLabel ? 144 : 48,
              height: showLabel ? 92 : 48,
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
