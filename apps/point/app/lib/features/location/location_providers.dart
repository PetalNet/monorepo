import 'dart:async';

import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/location/data/location_service.dart';

/// The battery engine. A single instance for the app; the ghost controller and
/// the app-lifecycle observer drive it. On web there is no background service —
/// the service still runs (geolocator has a web impl) but the foreground-service
/// bits are Android-only no-ops.
final locationServiceProvider = Provider<LocationService>((ref) {
  final service = LocationService();
  ref.onDispose(() {
    // Fire-and-forget async dispose.
    unawaited(service.dispose());
  });
  return service;
});
