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
      expect(m.plan.gpsInterval, const EngineConfig().fastInterval);
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
