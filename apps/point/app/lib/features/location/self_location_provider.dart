import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/location/data/location_service.dart';
import 'package:point_app/features/location/location_providers.dart';

/// The signed-in user's own latest GPS [Fix], streamed from the battery engine.
/// The map centers its self-marker on this; a [StreamProvider] caches the most
/// recent value so a rebuild (or a tab switch back to the map) keeps the dot
/// where it was rather than snapping to the fallback.
final selfLocationProvider = StreamProvider<Fix>((ref) {
  return ref.watch(locationServiceProvider).fixes;
});
