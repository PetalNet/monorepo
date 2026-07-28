import 'dart:async';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' show PointMode;

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:point_app/features/relay/relay_controller.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/theme/presence_tokens.dart';

/// A reported horizontal accuracy at least this coarse marks a peer's
/// position as APPROXIMATE: an area, not a point. Mirrors the smallest fuzz
/// preset (`FUZZ_RADIUS_NEAR_M` / `fuzzRadiusPresetsM().first`) so a fuzzed
/// cell-center — whose payload carries the cell radius as its accuracy — and
/// an equally coarse platform fix (cell-tower locate) get the same honest
/// treatment.
const approximateAccuracyFloorM = 300.0;

/// A dark peer's frozen last-known point may carry a precise accuracy, which
/// would shrink the static to invisibility. The aura never renders smaller
/// than this on screen — "signal lost" must be readable at any zoom.
const minDarkStaticRadiusPx = 26.0;

/// Cap on the painted radius so a city-scale cloud on a zoomed-in camera
/// cannot swallow the viewport or stall the raster thread. The speckle count
/// is area-scaled under the same cap.
const maxStaticRadiusPx = 280.0;

/// Where the TV-static treatment applies (task-751): a peer whose position is
/// approximate (coarse/fuzzed accuracy) or who has gone DARK (frozen
/// last-known point). Pure so the trigger is unit-testable apart from the map.
///
/// Returns the geographic radius to cover, and whether the dark on-screen
/// floor applies; `null` means a plain precise marker.
({double radiusM, bool dark})? fuzzStaticSpec(Person person, double? accuracyM) {
  if (!person.hasLocation) return null;
  final coarse = accuracyM != null && accuracyM >= approximateAccuracyFloorM;
  final dark = person.presence == PresenceState.stale;
  if (!coarse && !dark) return null;
  return (radiusM: coarse ? accuracyM : (accuracyM ?? 0), dark: dark);
}

/// The map layer that puts the TV-static under dark/approximate peers.
///
/// Rendered inside the map's layer stack BELOW the person markers: each
/// qualifying peer gets a [FuzzStaticOverlay] centered on their coordinate,
/// sized by projecting the geographic radius through the live camera (the
/// same projection the markers use), so the cloud hugs the fuzz radius at
/// every zoom.
class FuzzStaticMapLayer extends StatelessWidget {
  const FuzzStaticMapLayer({
    required this.people,
    required this.motions,
    required this.reducedMotion,
    super.key,
  });

  final List<Person> people;
  final Map<String, PeerMarkerMotion> motions;
  final bool reducedMotion;

  @override
  Widget build(BuildContext context) {
    final camera = MapCamera.of(context);
    return Stack(
      children: [
        for (final person in people)
          if (fuzzStaticSpec(person, motions[person.userId]?.target.accuracy)
              case final spec?)
            _PlacedStatic(
              key: ValueKey('fuzz-static-${person.userId}'),
              person: person,
              spec: spec,
              camera: camera,
              animate: !reducedMotion,
            ),
      ],
    );
  }
}

class _PlacedStatic extends StatelessWidget {
  const _PlacedStatic({
    required this.person,
    required this.spec,
    required this.camera,
    required this.animate,
    super.key,
  });

  final Person person;
  final ({double radiusM, bool dark}) spec;
  final MapCamera camera;
  final bool animate;

  @override
  Widget build(BuildContext context) {
    final point = LatLng(person.lat!, person.lon!);
    final projected = camera.projectAtZoom(point);
    final center = projected - camera.pixelOrigin;
    // Meters → screen px through the camera's own projection, at this
    // latitude, so the cloud stays glued to the geographic radius.
    final east = const Distance().offset(point, spec.radiusM, 90);
    final radiusFromMeters = (camera.projectAtZoom(east) - projected).distance;
    final radiusPx = math.min(
      spec.dark
          ? math.max(radiusFromMeters, minDarkStaticRadiusPx)
          : radiusFromMeters,
      maxStaticRadiusPx,
    );
    if (radiusPx < 3) return const SizedBox.shrink();
    return Positioned(
      left: center.dx - radiusPx,
      top: center.dy - radiusPx,
      width: radiusPx * 2,
      height: radiusPx * 2,
      child: IgnorePointer(
        child: ExcludeSemantics(
          child: FuzzStaticOverlay(
            radiusPx: radiusPx,
            seed: person.userId.hashCode,
            animate: animate,
          ),
        ),
      ),
    );
  }
}

/// The TV-static itself: monochrome speckle noise clipped to the fuzz circle,
/// shimmering at a low frame rate. Deterministic per (seed, frame) so tests
/// and screenshots are reproducible; honors reduced motion by freezing the
/// grain (the area still reads — only the flicker stops).
class FuzzStaticOverlay extends StatefulWidget {
  const FuzzStaticOverlay({
    required this.radiusPx,
    required this.seed,
    this.animate = true,
    super.key,
  });

  final double radiusPx;
  final int seed;
  final bool animate;

  @override
  State<FuzzStaticOverlay> createState() => _FuzzStaticOverlayState();
}

class _FuzzStaticOverlayState extends State<FuzzStaticOverlay> {
  // ~12 fps: enough for the analog-static shimmer, cheap for a map layer.
  static const _frameInterval = Duration(milliseconds: 84);
  Timer? _flicker;
  int _frame = 0;

  @override
  void initState() {
    super.initState();
    _syncFlicker();
  }

  @override
  void didUpdateWidget(FuzzStaticOverlay oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.animate != widget.animate) _syncFlicker();
  }

  void _syncFlicker() {
    _flicker?.cancel();
    _flicker = widget.animate
        ? Timer.periodic(_frameInterval, (_) => setState(() => ++_frame))
        : null;
  }

  @override
  void dispose() {
    _flicker?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return CustomPaint(
      size: Size.square(widget.radiusPx * 2),
      painter: TvStaticPainter(
        seed: widget.seed ^ (_frame * 0x9e3779b9),
        grain: Theme.of(context).colorScheme.onSurface,
      ),
    );
  }
}

/// Uniform-density speckles over the circle, bucketed into four alpha levels
/// so the whole cloud rasters in four point-batch draw calls per frame.
@visibleForTesting
class TvStaticPainter extends CustomPainter {
  const TvStaticPainter({required this.seed, required this.grain});

  final int seed;
  final Color grain;

  @override
  void paint(Canvas canvas, Size size) {
    final radius = size.shortestSide / 2;
    final center = size.center(Offset.zero);
    // Faint wash so the covered area reads even between speckles.
    canvas.drawCircle(
      center,
      radius,
      Paint()..color = grain.withValues(alpha: 0.05),
    );
    final random = math.Random(seed);
    final count = (radius * radius * math.pi / 30).clamp(48, 1400).toInt();
    final buckets = List.generate(4, (_) => <double>[]);
    for (var i = 0; i < count; i++) {
      // sqrt keeps areal density uniform out to the rim.
      final r = radius * math.sqrt(random.nextDouble());
      final theta = random.nextDouble() * 2 * math.pi;
      buckets[random.nextInt(4)]
        ..add(center.dx + r * math.cos(theta))
        ..add(center.dy + r * math.sin(theta));
    }
    for (var level = 0; level < buckets.length; level++) {
      canvas.drawRawPoints(
        PointMode.points,
        Float32List.fromList(buckets[level]),
        Paint()
          ..color = grain.withValues(alpha: 0.10 + level * 0.12)
          ..strokeWidth = 1.6 + level * 0.4
          ..strokeCap = StrokeCap.square,
      );
    }
  }

  @override
  bool shouldRepaint(covariant TvStaticPainter oldDelegate) =>
      oldDelegate.seed != seed || oldDelegate.grain != grain;
}
