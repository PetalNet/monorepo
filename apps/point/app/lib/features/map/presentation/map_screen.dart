import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:latlong2/latlong.dart';
import 'package:point_app/app/point_app.dart';
import 'package:point_app/app/routes.dart';
import 'package:point_app/features/location/self_location_provider.dart';
import 'package:point_app/features/map/presentation/person_map_sheet.dart';
import 'package:point_app/features/map/presentation/presence_marker.dart';
import 'package:point_app/features/map/presentation/self_marker.dart';
import 'package:point_app/features/people/people_presence.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/auth_controller.dart';
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

class _MapScreenState extends ConsumerState<MapScreen> {
  final _mapController = MapController();
  bool _centeredOnSelf = false;

  @override
  void dispose() {
    _mapController.dispose();
    super.dispose();
  }

  void _moveTo(LatLng point) =>
      _mapController.move(point, MapScreen._neighborhoodZoom);

  @override
  Widget build(BuildContext context) {
    final self = ref.watch(selfLocationProvider).value;
    final selfPoint = self != null ? LatLng(self.lat, self.lon) : null;

    // Start the camera on YOU the first time a fix lands, then never yank it.
    ref.listen(selfLocationProvider, (_, next) {
      final fix = next.value;
      if (fix != null && !_centeredOnSelf) {
        _centeredOnSelf = true;
        _moveTo(LatLng(fix.lat, fix.lon));
      }
    });

    // Only people with a live/known coordinate plot; dark/location-off don't.
    final located =
        ref.watch(peopleWithPresenceProvider).where((p) => p.hasLocation).toList();

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
            ),
            children: [
              TileLayer(
                urlTemplate:
                    'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
                subdomains: const ['a', 'b', 'c', 'd'],
                retinaMode: RetinaMode.isHighDensity(context),
                userAgentPackageName: 'dev.petalcat.point',
                tileBuilder: (context, child, tile) => child,
              ),
              _PeopleMarkers(people: located, onFocus: _moveTo),
              if (selfPoint != null) _SelfMarkerLayer(point: selfPoint),
            ],
          ),
        ],
      ),
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
  const _PeopleMarkers({required this.people, required this.onFocus});
  final List<Person> people;
  final void Function(LatLng) onFocus;

  @override
  Widget build(BuildContext context) {
    return MarkerLayer(
      markers: [
        for (final p in people)
          Marker(
            point: LatLng(p.lat!, p.lon!),
            width: 96,
            height: 72,
            alignment: Alignment.topCenter,
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () => PersonMapSheet.show(
                context,
                person: p,
                onFocus: () => onFocus(LatLng(p.lat!, p.lon!)),
                onOpenDetail: () => context.push(PersonDetailRoute(p.userId)),
              ),
              child: PresenceMarker(person: p),
            ),
          ),
      ],
    );
  }
}
