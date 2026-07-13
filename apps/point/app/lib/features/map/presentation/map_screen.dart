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
import 'package:point_app/features/relay/relay_controller.dart';
import 'package:point_app/features/settings/app_settings.dart';
import 'package:point_app/features/settings/settings_controller.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/theme/presence_tokens.dart';
import 'package:point_app/theme/theme_x.dart';

/// Map + presence (spec 07): a monochrome basemap centered on YOU, all active
/// sharers' markers, a "recenter on me" FAB, and a go-dark entry. Dark /
/// location-off people don't plot (their frozen last-known lives in People).
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
    _cameraAnimation.forward(from: 0);
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
    final reducedMotion = _reducedMotion;

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

    // Only currently-LIVE people plot; dark people (stale last-known) and
    // location-off people don't get a live pin — their frozen last-known lives
    // in People/detail.
    final located = ref
        .watch(peopleWithPresenceProvider)
        .where((p) => p.presence == PresenceState.live && p.hasLocation)
        .toList();

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
        onPressed: selfPoint == null ? null : () => _moveTo(selfPoint),
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
                reducedMotion: reducedMotion,
                onFocus: (person) => _moveTo(
                  LatLng(person.lat!, person.lon!),
                  followUserId: person.userId,
                ),
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
                          .where(
                            (person) => person.userId == _follow.userId,
                          )
                          .firstOrNull
                          ?.displayName,
                      onStop: () => setState(
                        () => _follow = _follow.onUserGesture(),
                      ),
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
class _PeopleMarkers extends StatelessWidget {
  const _PeopleMarkers({
    required this.people,
    required this.motions,
    required this.reducedMotion,
    required this.onFocus,
    required this.onPosition,
  });
  final List<Person> people;
  final Map<String, PeerMarkerMotion> motions;
  final bool reducedMotion;
  final void Function(Person) onFocus;
  final void Function(String, LatLng) onPosition;

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        for (final person in people)
          _AnimatedPersonMarkerLayer(
            person: person,
            motion: motions[person.userId],
            reducedMotion: reducedMotion,
            onPosition: onPosition,
            onTap: () => PersonMapSheet.show(
              context,
              person: person,
              onFocus: () => onFocus(person),
              onOpenDetail: () =>
                  context.push(PersonDetailRoute(person.userId)),
            ),
          ),
      ],
    );
  }
}

class _AnimatedPersonMarkerLayer extends StatelessWidget {
  const _AnimatedPersonMarkerLayer({
    required this.person,
    required this.motion,
    required this.reducedMotion,
    required this.onPosition,
    required this.onTap,
  });

  final Person person;
  final PeerMarkerMotion? motion;
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
      child: PresenceMarker(person: person, onTap: onTap),
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
                  Icon(
                    Icons.near_me,
                    color: context.colors.onInverseSurface,
                  ),
                  SizedBox(width: context.space.sm),
                  Text(
                    name == null ? 'Following' : 'Following $name',
                    style: context.text.labelLarge?.copyWith(
                      color: context.colors.onInverseSurface,
                    ),
                  ),
                  SizedBox(width: context.space.sm),
                  Icon(
                    Icons.close,
                    color: context.colors.onInverseSurface,
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
