import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:point_app/src/rust/api/fuzz.dart';
import 'package:point_app/src/rust/frb_generated.dart';

const _secret = [
  115, 109, 111, 107, 101, 45, 116, 101, 115, 116, 45, 115, 101, 99, 114,
  101, 116, 45, 51, 50, 45, 98, 121, 116, 101, 115, 45, 108, 111, 110, 103,
  33,
];
const _sharer = 'janet@point.dev';

double _haversineM(double lat1, double lon1, double lat2, double lon2) {
  const r = 6371000.0;
  final p1 = lat1 * pi / 180;
  final p2 = lat2 * pi / 180;
  final dp = (lat2 - lat1) * pi / 180;
  final dl = (lon2 - lon1) * pi / 180;
  final a =
      sin(dp / 2) * sin(dp / 2) + cos(p1) * cos(p2) * sin(dl / 2) * sin(dl / 2);
  return 2 * r * asin(sqrt(a));
}

void main() {
  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    await RustLib.init();
  });

  test('stable_fuzz is callable over FFI and byte-deterministic', () {
    final a = stableFuzz(
      trueLat: 38.6270,
      trueLon: -90.1994,
      radiusM: 1000,
      sharerId: _sharer,
      audienceId: 'grp:family',
      secret: _secret,
    );
    final b = stableFuzz(
      trueLat: 38.6270,
      trueLon: -90.1994,
      radiusM: 1000,
      sharerId: _sharer,
      audienceId: 'grp:family',
      secret: _secret,
    );
    expect(a, b);
    expect(a.lat, isNot(38.6270));
  });

  test('nearby fixes in the same cell share one snapped center', () {
    final base = stableFuzz(
      trueLat: 51.5074,
      trueLon: -0.1278,
      radiusM: 1000,
      sharerId: _sharer,
      audienceId: 'grp:family',
      secret: _secret,
    );
    var sameCell = 0;
    for (var i = 0; i < 40; i++) {
      final jitterLat = 51.5074 + (i - 20) * 0.00002;
      final jitterLon = -0.1278 + (20 - i) * 0.00002;
      final p = stableFuzz(
        trueLat: jitterLat,
        trueLon: jitterLon,
        radiusM: 1000,
        sharerId: _sharer,
        audienceId: 'grp:family',
        secret: _secret,
      );
      if (p.cellX == base.cellX && p.cellY == base.cellY) {
        sameCell++;
        expect(p.lat, base.lat);
        expect(p.lon, base.lon);
      }
    }
    expect(sameCell, greaterThan(0));
  });

  test('all audiences share one grid at a given radius (collusion-proof)', () {
    const lat = 40.7128;
    const lon = -74.0060;
    // The grid is derived from (sharer, radius) only, so any number of
    // audiences at the same radius snap the true point to the SAME cell — a
    // colluding set of audiences learns only that one cell, at any N.
    final reports = [
      for (final audience in ['grp:family', 'grp:friends', 'usr:eve', 'aud:9'])
        stableFuzz(
          trueLat: lat,
          trueLon: lon,
          radiusM: 1000,
          sharerId: _sharer,
          audienceId: audience,
          secret: _secret,
        ),
    ];
    final first = reports.first;
    for (final p in reports) {
      expect(p.cellX, first.cellX);
      expect(p.cellY, first.cellY);
      expect(p.lat, first.lat);
      expect(p.lon, first.lon);
    }
    expect(_haversineM(lat, lon, first.lat, first.lon), lessThanOrEqualTo(1000.0));
  });

  test('crossing a cell boundary moves the snapped center', () {
    final start = stableFuzz(
      trueLat: 48.8566,
      trueLon: 2.3522,
      radiusM: 300,
      sharerId: _sharer,
      audienceId: 'grp:family',
      secret: _secret,
    );
    var lon = 2.3522;
    FuzzedPoint? crossed;
    for (var i = 0; i < 300; i++) {
      lon += 300.0 / 111320.0 / 50.0;
      final p = stableFuzz(
        trueLat: 48.8566,
        trueLon: lon,
        radiusM: 300,
        sharerId: _sharer,
        audienceId: 'grp:family',
        secret: _secret,
      );
      if (p.cellX != start.cellX) {
        crossed = p;
        break;
      }
      expect(p.lat, start.lat);
      expect(p.lon, start.lon);
    }
    expect(crossed, isNotNull);
    expect(crossed!.lon, isNot(start.lon));
  });

  test('radius presets come through the bridge as 300 / 1000 / 5000', () {
    expect(fuzzRadiusPresetsM(), [300.0, 1000.0, 5000.0]);
  });
}
