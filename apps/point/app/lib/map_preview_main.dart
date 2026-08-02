import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/location/data/location_service.dart';
import 'package:point_app/features/location/self_location_provider.dart';
import 'package:point_app/features/map/presentation/map_screen.dart';
import 'package:point_app/features/people/people_controller.dart';
import 'package:point_app/features/relay/relay_controller.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/theme/app_theme.dart';
import 'package:point_app/theme/presence_tokens.dart';

/// Craft-only render preview of the Map tab (Wave 1): overrides the self-location
/// and people providers with fixtures so the self photo-dot marker, sharer
/// markers, recenter FAB, and go-dark entry can be inspected without a server or
/// live GPS. The REAL self-marker (live GPS) and the REAL receive→plot path are
/// verified on-device separately — this is only for pixel craft.
void main() {
  runApp(
    ProviderScope(
      overrides: [
        selfLocationProvider.overrideWith(
          (ref) => Stream<Fix>.value(
            const Fix(
              lat: 38.627,
              lon: -90.199,
              speed: 0,
              accuracy: 8,
              timestampMs: 0,
            ),
          ),
        ),
        peopleControllerProvider.overrideWith(_PreviewPeople.new),
        livePresenceProvider.overrideWith(_PreviewLive.new),
        authControllerProvider.overrideWith(_PreviewAuth.new),
      ],
      child: const _PreviewApp(),
    ),
  );
}

class _PreviewApp extends StatelessWidget {
  const _PreviewApp();
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: AppTheme.dark(pureBlack: true),
      darkTheme: AppTheme.dark(pureBlack: true),
      themeMode: ThemeMode.dark,
      home: const MapScreen(),
    );
  }
}

class _PreviewAuth extends AuthController {
  @override
  Future<Session?> build() async => const Session(
        userId: 'parker@point.petalcat.dev',
        token: 't',
        displayName: 'Parker H',
        isAdmin: true,
      );
}

class _PreviewPeople extends PeopleController {
  @override
  Future<List<Person>> build() async => const [
        Person(
          userId: 'eli@point.petalcat.dev',
          displayName: 'Eli',
          presence: PresenceState.live,
          subtitle: '0.4 mi · moving',
          lat: 38.631,
          lon: -90.201,
        ),
        Person(
          userId: 'mara@point.petalcat.dev',
          displayName: 'Mara Q',
          presence: PresenceState.away,
          subtitle: 'Last seen 20m ago',
          lat: 38.624,
          lon: -90.192,
        ),
        // Task 751 fixtures: a DARK peer (frozen last-known + static aura) and
        // an APPROXIMATE peer (coarse fix -> static over the fuzz radius).
        Person(
          userId: 'noor@point.petalcat.dev',
          displayName: 'Noor',
          presence: PresenceState.stale,
          subtitle: 'Last place · Dark since 14:07',
          lat: 38.633,
          lon: -90.191,
          darkSinceAt: 1747145220000,
        ),
        Person(
          userId: 'janet@point.petalcat.dev',
          displayName: 'Janet',
          presence: PresenceState.live,
          subtitle: 'Sharing · ±800 m · now',
          lat: 38.620,
          lon: -90.205,
        ),
      ];
}

/// A coarse (fuzzed-scale) fix for Janet so the approximate path renders.
class _PreviewLive extends LivePresence {
  @override
  Map<String, PeerMarkerMotion> build() => {
        'janet@point.petalcat.dev': PeerMarkerMotion.initial(
          PeerFix(
            userId: 'janet@point.petalcat.dev',
            data: {
              'lat': 38.620,
              'lon': -90.205,
              'accuracy': 800,
              'timestamp': DateTime.now().millisecondsSinceEpoch,
            },
          ),
        ),
      };
}
