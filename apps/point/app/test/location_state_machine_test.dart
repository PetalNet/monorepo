import 'package:flutter_test/flutter_test.dart';
import 'package:point_app/features/location/domain/location_state_machine.dart';

void main() {
  group('LocationStateMachine', () {
    test('starts idle when sharing, ghost when not', () {
      expect(LocationStateMachine().activity, LocationActivity.idle);
      expect(
        LocationStateMachine(sharing: false).activity,
        LocationActivity.ghost,
      );
    });

    test('foreground open jumps to active for a fresh fix', () {
      final m = LocationStateMachine()..onForeground();
      expect(m.activity, LocationActivity.active);
    });

    test('background keeps the engine running at a calmer cadence (GO-bar #1)',
        () {
      final m = LocationStateMachine()..onForeground();
      final fg = m.plan.gpsInterval;
      m.onBackground();
      final bg = m.plan.gpsInterval;
      // Still sampling (engine did NOT stop when backgrounded) but slower.
      expect(m.plan.gpsEnabled, isTrue);
      expect(bg, greaterThan(fg));
      expect(m.plan.foregroundService, isTrue);
    });

    test('active promotes to fast after sustained speed', () {
      final m = LocationStateMachine()..onForeground();
      for (var i = 0; i < 3; i++) {
        m.onGpsFix(speed: 8, movedMetres: 20);
      }
      expect(m.activity, LocationActivity.fast);
      expect(m.plan.gpsInterval, const EngineConfig().fastForeground);
    });

    test('DOCUMENTED cadence tables: foreground moving = 2s / 0m filter for '
        'both driving and walking (location-strategy Layer 3)', () {
      // Walking (active), foreground.
      final walk = LocationStateMachine()..onForeground();
      expect(walk.activity, LocationActivity.active);
      expect(walk.plan.gpsInterval, const Duration(seconds: 2));
      expect(walk.plan.distanceFilter, 0);

      // Driving (fast), foreground.
      final drive = LocationStateMachine()..onForeground();
      for (var i = 0; i < 3; i++) {
        drive.onGpsFix(speed: 8, movedMetres: 20);
      }
      expect(drive.activity, LocationActivity.fast);
      expect(drive.plan.gpsInterval, const Duration(seconds: 2));
      expect(drive.plan.distanceFilter, 0);
    });

    test('DOCUMENTED cadence tables: background moving = driving 10s/25m, '
        'walking 15s/10m (location-strategy Layer 3)', () {
      // Walking (active), background: 15s GPS, 10m filter.
      final walk = LocationStateMachine()
        ..onForeground()
        ..onBackground();
      expect(walk.activity, LocationActivity.active);
      expect(walk.plan.gpsInterval, const Duration(seconds: 15));
      expect(walk.plan.distanceFilter, 10);

      // Driving (fast), background: 10s GPS, 25m filter.
      final drive = LocationStateMachine()..onForeground();
      for (var i = 0; i < 3; i++) {
        drive.onGpsFix(speed: 8, movedMetres: 20);
      }
      drive.onBackground();
      expect(drive.activity, LocationActivity.fast);
      expect(drive.plan.gpsInterval, const Duration(seconds: 10));
      expect(drive.plan.distanceFilter, 25);
    });

    test('R17: speed-tier boundaries are STRICT — a 5.0 m/s jogger is NOT '
        'driving, and exactly 2.0 m/s does not demote', () {
      // Exactly 5.0 m/s sustained must stay active (spec is > 5, not >= 5): a
      // fast jogger / cyclist at the boundary is walking-tier, not driving.
      final jog = LocationStateMachine()..onForeground();
      for (var i = 0; i < 5; i++) {
        jog.onGpsFix(speed: 5, movedMetres: 10);
      }
      expect(
        jog.activity,
        LocationActivity.active,
        reason: 'exactly 5.0 m/s must not promote to fast (strict > 5)',
      );

      // Just over the boundary DOES promote.
      final drive = LocationStateMachine()..onForeground();
      for (var i = 0; i < 3; i++) {
        drive.onGpsFix(speed: 5.01, movedMetres: 10);
      }
      expect(drive.activity, LocationActivity.fast);

      // Demotion is strict < 2: exactly 2.0 m/s must NOT demote a driver.
      for (var i = 0; i < 10; i++) {
        drive.onGpsFix(speed: 2, movedMetres: 5);
      }
      expect(
        drive.activity,
        LocationActivity.fast,
        reason: 'exactly 2.0 m/s must not demote (strict < 2)',
      );

      // Just under the boundary DOES demote.
      for (var i = 0; i < 5; i++) {
        drive.onGpsFix(speed: 1.99, movedMetres: 2);
      }
      expect(drive.activity, LocationActivity.active);
    });

    test('fast demotes to active after sustained slowness', () {
      final m = LocationStateMachine()..onForeground();
      for (var i = 0; i < 3; i++) {
        m.onGpsFix(speed: 8, movedMetres: 20);
      }
      expect(m.activity, LocationActivity.fast);
      for (var i = 0; i < 5; i++) {
        m.onGpsFix(speed: 0.5, movedMetres: 1);
      }
      expect(m.activity, LocationActivity.active);
    });

    test('stillness ramps down active -> idle -> sleeping', () {
      final m = LocationStateMachine()..onForeground();
      expect(m.activity, LocationActivity.active);
      m.onStillness();
      expect(m.activity, LocationActivity.idle);
      m.onStillness();
      expect(m.activity, LocationActivity.sleeping);
    });

    test('movement wakes the engine from sleeping', () {
      final m = LocationStateMachine()
        ..onStillness()
        ..onStillness();
      expect(m.activity, LocationActivity.sleeping);
      m.onGpsFix(speed: 1, movedMetres: 30);
      expect(m.activity, LocationActivity.active);
    });

    test('ghost hard-stops the engine (kills GPS + service), unlike legacy', () {
      final m = LocationStateMachine()..onForeground();
      expect(m.plan.gpsEnabled, isTrue);
      m.setSharing(sharing: false);
      expect(m.activity, LocationActivity.ghost);
      expect(m.plan.gpsEnabled, isFalse); // GPS actually off — the wired hook
      expect(m.plan.foregroundService, isFalse);
      // A fix arriving while ghosted is ignored.
      m.onGpsFix(speed: 9, movedMetres: 50);
      expect(m.activity, LocationActivity.ghost);
    });

    test('leaving ghost returns to idle so the next fix re-evaluates', () {
      final m = LocationStateMachine(sharing: false)
        ..setSharing(sharing: true);
      expect(m.activity, LocationActivity.idle);
      expect(m.plan.gpsEnabled, isTrue);
    });
  });
}
