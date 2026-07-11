import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:latlong2/latlong.dart';
import 'package:point_app/app/point_app.dart';
import 'package:point_app/app/routes.dart';
import 'package:point_app/features/map/presentation/presence_marker.dart';
import 'package:point_app/features/people/people_controller.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/theme/theme_x.dart';
import 'package:point_app/widgets/person_row.dart';

/// Map + presence (mockup screen 1): a monochrome basemap with presence markers
/// (form, not color), a recenter action, a ghost entry, and a draggable sheet
/// of nearby people. Only the marker layer rebuilds on presence change.
class MapScreen extends ConsumerWidget {
  const MapScreen({super.key});

  static const _fallbackCenter = LatLng(38.627, -90.199);

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final people = ref.watch(peopleProvider);
    final located = people.where((p) => p.hasLocation).toList();
    final center = located.isNotEmpty
        ? LatLng(located.first.lat!, located.first.lon!)
        : _fallbackCenter;

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
            tooltip: 'Ghost mode',
            onPressed: () => context.push(const GhostRoute()),
          ),
          IconButton(
            icon: const Icon(Icons.my_location),
            tooltip: 'Recenter',
            onPressed: () {},
          ),
        ],
      ),
      body: Stack(
        children: [
          // Dark on-brand fill behind the tiles: the basemap reads monochrome
          // even before tiles load (and in the offline render harness).
          Positioned.fill(
            child: ColoredBox(color: context.colors.surface),
          ),
          FlutterMap(
            options: MapOptions(
              initialCenter: center,
              interactionOptions: const InteractionOptions(
                flags: InteractiveFlag.all & ~InteractiveFlag.rotate,
              ),
            ),
            children: [
              TileLayer(
                // CARTO dark-matter — an on-brand monochrome basemap.
                urlTemplate:
                    'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
                subdomains: const ['a', 'b', 'c', 'd'],
                retinaMode: RetinaMode.isHighDensity(context),
                userAgentPackageName: 'dev.petalcat.point',
                tileBuilder: (context, child, tile) => child,
              ),
              _PresenceMarkers(people: located),
            ],
          ),
          const _NearbySheet(),
        ],
      ),
    );
  }
}

/// The marker layer — isolated so only it rebuilds when presence changes.
class _PresenceMarkers extends StatelessWidget {
  const _PresenceMarkers({required this.people});
  final List<Person> people;

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
            child: PresenceMarker(person: p),
          ),
      ],
    );
  }
}

/// Draggable bottom sheet of nearby people (same PersonRow as People).
class _NearbySheet extends ConsumerWidget {
  const _NearbySheet();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final people = ref.watch(peopleProvider);
    return DraggableScrollableSheet(
      initialChildSize: 0.28,
      minChildSize: 0.12,
      maxChildSize: 0.85,
      snap: true,
      builder: (context, controller) {
        return DecoratedBox(
          decoration: BoxDecoration(
            color: context.colors.surfaceContainer,
            borderRadius: context.radii.sheetTop,
          ),
          child: ListView.builder(
            controller: controller,
            padding: EdgeInsets.only(bottom: context.space.lg),
            itemCount: people.length + 1,
            itemBuilder: (context, i) {
              if (i == 0) return const _SheetHandle();
              return PersonRow(person: people[i - 1]);
            },
          ),
        );
      },
    );
  }
}

class _SheetHandle extends StatelessWidget {
  const _SheetHandle();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Container(
        margin: EdgeInsets.symmetric(vertical: context.space.md),
        width: 36,
        height: 4,
        decoration: BoxDecoration(
          color: context.colors.onSurfaceVariant.withValues(alpha: 0.5),
          borderRadius: BorderRadius.circular(context.radii.full),
        ),
      ),
    );
  }
}
