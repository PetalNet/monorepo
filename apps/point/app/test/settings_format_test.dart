import 'package:flutter_test/flutter_test.dart';
import 'package:point_app/features/people/people_presence.dart';
import 'package:point_app/features/settings/app_settings.dart';

void main() {
  group('AppSettings json', () {
    test('roundtrips every field', () {
      const s = AppSettings(
        mapProvider: MapProviderChoice.proxied,
        transportChosen: true,
        appearance: Appearance.pureBlack,
        motion: MotionPreference.reduced,
        haptics: HapticsLevel.enhanced,
        units: DistanceUnits.kilometers,
        timeFormat: TimeFormat.h24,
        textScale: 1.15,
        goDarkDefault: true,
      );
      expect(AppSettings.fromJson(s.toJson()), s);
    });

    test('migrates unsupported FCM while preserving completed onboarding', () {
      final s = AppSettings.fromJson(const {
        'transport': 'fcm',
        'fcm_fallback': true,
        'transport_chosen': true,
      });

      expect(s.transport, NotifTransport.unifiedPush);
      expect(s.fcmFallback, isFalse);
      expect(s.transportChosen, isTrue);
      expect(s.needsPushMigration, isTrue);

      final persisted = AppSettings.fromJson(s.toJson());
      expect(persisted.transport, NotifTransport.unifiedPush);
      expect(persisted.fcmFallback, isFalse);
      expect(persisted.needsPushMigration, isFalse);
    });

    test('rejects unsupported FCM updates', () {
      final s = const AppSettings().copyWith(
        transport: NotifTransport.fcm,
        fcmFallback: true,
        transportChosen: true,
      );

      expect(s.transport, NotifTransport.unifiedPush);
      expect(s.fcmFallback, isFalse);
      expect(s.transportChosen, isTrue);
      expect(s.needsPushMigration, isTrue);
    });

    test('normalizes unsupported direct construction', () {
      const s = AppSettings(
        transport: NotifTransport.fcm,
        fcmFallback: true,
      );

      expect(s.transport, NotifTransport.unifiedPush);
      expect(s.fcmFallback, isFalse);
    });

    test('unknown or missing values fall back to the defaults', () {
      final s = AppSettings.fromJson(const {
        'map_provider': 'google',
        'appearance': 'sepia',
      });
      expect(s.mapProvider, MapProviderChoice.selfHosted);
      expect(s.appearance, Appearance.dark);
      expect(s.haptics, HapticsLevel.standard);
      expect(s.units, DistanceUnits.miles);
      expect(s.timeFormat, TimeFormat.h12);
      expect(s.textScale, 1.0);
      expect(s.goDarkDefault, isFalse);
    });
  });

  group('clockHm', () {
    // 2026-01-05 16:05 local.
    final afternoon = DateTime(2026, 1, 5, 16, 5).millisecondsSinceEpoch;
    final midnightish = DateTime(2026, 1, 5, 0, 30).millisecondsSinceEpoch;
    final noon = DateTime(2026, 1, 5, 12, 3).millisecondsSinceEpoch;

    test('24 hour (the default)', () {
      expect(clockHm(afternoon), '16:05');
      expect(clockHm(midnightish), '00:30');
    });

    test('12 hour', () {
      expect(clockHm(afternoon, format: TimeFormat.h12), '4:05 pm');
      expect(clockHm(midnightish, format: TimeFormat.h12), '12:30 am');
      expect(clockHm(noon, format: TimeFormat.h12), '12:03 pm');
    });
  });

  group('formatDistance', () {
    test('miles ladder', () {
      expect(formatDistance(30, DistanceUnits.miles), '98 ft');
      expect(formatDistance(650, DistanceUnits.miles), '0.4 mi');
      expect(formatDistance(16093, DistanceUnits.miles), '10 mi');
      expect(formatDistance(40000, DistanceUnits.miles), '25 mi');
    });

    test('kilometers ladder', () {
      expect(formatDistance(30, DistanceUnits.kilometers), '30 m');
      expect(formatDistance(1400, DistanceUnits.kilometers), '1.4 km');
      expect(formatDistance(40000, DistanceUnits.kilometers), '40 km');
    });
  });
}
