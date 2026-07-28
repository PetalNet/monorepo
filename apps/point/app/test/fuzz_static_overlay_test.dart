import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:latlong2/latlong.dart';
import 'package:point_app/features/map/presentation/fuzz_static_overlay.dart';
import 'package:point_app/features/relay/relay_controller.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/theme/app_theme.dart';
import 'package:point_app/theme/presence_tokens.dart';

// Task 751 regression: the fuzz DATA layer existed but a dark/approximate
// peer rendered as a plain marker — no TV-static over the fuzz radius.

const _dark = Person(
  userId: 'noor@point.dev',
  displayName: 'Noor',
  presence: PresenceState.stale,
  subtitle: 'Last place · Dark since 14:07',
  lat: 38.63,
  lon: -90.19,
  darkSinceAt: 1747145220000,
);

const _livePrecise = Person(
  userId: 'eli@point.dev',
  displayName: 'Eli',
  presence: PresenceState.live,
  subtitle: 'Sharing · now',
  lat: 38.62,
  lon: -90.20,
);

const _liveCoarse = Person(
  userId: 'janet@point.dev',
  displayName: 'Janet',
  presence: PresenceState.live,
  subtitle: 'Sharing · ±800 m · now',
  lat: 38.61,
  lon: -90.21,
);

PeerMarkerMotion _motion(String userId, double lat, double lon, num accuracy) =>
    PeerMarkerMotion.initial(
      PeerFix(
        userId: userId,
        data: {'lat': lat, 'lon': lon, 'accuracy': accuracy, 'timestamp': 1},
      ),
    );

void main() {
  group('fuzzStaticSpec (who gets the static)', () {
    test('dark peer → static, even with a precise last-known accuracy', () {
      final spec = fuzzStaticSpec(_dark, 12);
      expect(spec, isNotNull);
      expect(spec!.dark, isTrue);
    });

    test('dark peer with no accuracy at all still statics', () {
      expect(fuzzStaticSpec(_dark, null), isNotNull);
    });

    test('approximate (coarse) peer → static over the reported radius', () {
      final spec = fuzzStaticSpec(_liveCoarse, 800);
      expect(spec, isNotNull);
      expect(spec!.radiusM, 800);
      expect(spec.dark, isFalse);
    });

    test('the approximate floor mirrors the smallest fuzz preset', () {
      expect(approximateAccuracyFloorM, 300.0);
      expect(fuzzStaticSpec(_livePrecise, 299.9), isNull);
      expect(fuzzStaticSpec(_livePrecise, 300), isNotNull);
    });

    test('live precise peer → plain marker, no static', () {
      expect(fuzzStaticSpec(_livePrecise, 12), isNull);
      expect(fuzzStaticSpec(_livePrecise, null), isNull);
    });

    test('locationless peer → nothing to cover', () {
      const locationless = Person(
        userId: 'x@point.dev',
        displayName: 'X',
        presence: PresenceState.stale,
      );
      expect(fuzzStaticSpec(locationless, 900), isNull);
    });
  });

  group('FuzzStaticOverlay', () {
    Widget host(Widget child) => MaterialApp(
      theme: AppTheme.dark(pureBlack: true),
      home: Scaffold(body: Center(child: child)),
    );

    TvStaticPainter painterOf(WidgetTester tester) {
      final paint = tester.widget<CustomPaint>(
        find.byWidgetPredicate(
          (w) => w is CustomPaint && w.painter is TvStaticPainter,
        ),
      );
      return paint.painter! as TvStaticPainter;
    }

    testWidgets('shimmers: the grain reseeds every flicker frame', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(const FuzzStaticOverlay(radiusPx: 40, seed: 7)),
      );
      final before = painterOf(tester).seed;
      await tester.pump(const Duration(milliseconds: 100));
      expect(painterOf(tester).seed, isNot(before));
      // Deterministic per frame: same (seed, frame) → reproducible grain.
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('reduced motion freezes the grain but keeps the area', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(const FuzzStaticOverlay(radiusPx: 40, seed: 7, animate: false)),
      );
      final before = painterOf(tester).seed;
      await tester.pump(const Duration(milliseconds: 500));
      expect(painterOf(tester).seed, before);
    });
  });

  group('FuzzStaticMapLayer (on the map)', () {
    Widget mapHost(List<Person> people, Map<String, PeerMarkerMotion> motions) {
      return MaterialApp(
        theme: AppTheme.dark(pureBlack: true),
        home: Scaffold(
          body: FlutterMap(
            options: const MapOptions(
              initialCenter: LatLng(38.62, -90.20),
              initialZoom: 13.5,
            ),
            children: [
              FuzzStaticMapLayer(
                people: people,
                motions: motions,
                reducedMotion: true,
              ),
            ],
          ),
        ),
      );
    }

    testWidgets('dark and approximate peers get static; precise ones do not', (
      tester,
    ) async {
      await tester.pumpWidget(
        mapHost(
          const [_dark, _livePrecise, _liveCoarse],
          {
            'eli@point.dev': _motion('eli@point.dev', 38.62, -90.20, 12),
            'janet@point.dev': _motion('janet@point.dev', 38.61, -90.21, 800),
          },
        ),
      );
      await tester.pump();

      expect(find.byType(FuzzStaticOverlay), findsNWidgets(2));
      expect(
        find.byKey(const ValueKey('fuzz-static-noor@point.dev')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('fuzz-static-janet@point.dev')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('fuzz-static-eli@point.dev')),
        findsNothing,
      );
    });

    testWidgets('the approximate cloud covers the geographic radius on '
        'screen', (tester) async {
      await tester.pumpWidget(
        mapHost(const [_liveCoarse], {
          'janet@point.dev': _motion('janet@point.dev', 38.61, -90.21, 800),
        }),
      );
      await tester.pump();

      final overlay = tester.widget<FuzzStaticOverlay>(
        find.byType(FuzzStaticOverlay),
      );
      // 800 m at zoom 13 (~14.9 m/px at this latitude) ≈ 54 px — the point is
      // that it scales geographically: far bigger than the dark floor, far
      // smaller than the cap.
      expect(overlay.radiusPx, greaterThan(minDarkStaticRadiusPx));
      expect(overlay.radiusPx, lessThan(maxStaticRadiusPx));
    });

    testWidgets('a dark peer with precise last-known accuracy keeps a '
        'readable minimum aura', (tester) async {
      await tester.pumpWidget(
        mapHost(const [_dark], {
          'noor@point.dev': _motion('noor@point.dev', 38.63, -90.19, 10),
        }),
      );
      await tester.pump();

      final overlay = tester.widget<FuzzStaticOverlay>(
        find.byType(FuzzStaticOverlay),
      );
      expect(overlay.radiusPx, minDarkStaticRadiusPx);
    });
  });
}
