import 'dart:async';
import 'dart:convert';

import 'package:fake_async/fake_async.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator/geolocator.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/location/data/location_service.dart';
import 'package:point_app/features/location/domain/location_state_machine.dart';
import 'package:point_app/features/location/engine_session.dart';
import 'package:point_app/features/location/location_providers.dart';
import 'package:point_app/features/settings/app_settings.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/api/point_api.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:sensors_plus/sensors_plus.dart';

/// Regression guards for the v1.2 location-acquisition wedge (tracker 721):
/// the signed-out hard-stop (`setSharing(false)` → ghost) leaked into the
/// next session, and `start()` faithfully applied the ghosted plan — so a
/// fresh install or a sign-out → sign-in ran the engine dark until a process
/// restart: no self-marker, dead recenter, zero fixes sent.
///
/// Two altitudes, matching the two halves of the bug:
///  1. [LocationService] with injected platform seams — the acquisition path
///     itself (permission → plan → GPS stream → [Fix]es out), headless.
///  2. [establishSessionEngineState] — the sign-in wiring that must clear the
///     leftover hard-stop before the gate starts the engine, without
///     trampling the go-dark default.
Position _pos({double lat = 38.69, double lon = -90.43, double speed = 0}) =>
    Position(
      latitude: lat,
      longitude: lon,
      timestamp: DateTime.fromMillisecondsSinceEpoch(1752357600000),
      accuracy: 5,
      altitude: 0,
      altitudeAccuracy: 0,
      heading: 0,
      headingAccuracy: 0,
      speed: speed,
      speedAccuracy: 0,
    );

class _Harness {
  _Harness({LocationPermission permission = LocationPermission.always})
      : _permission = permission {
    service = LocationService(
      checkPermission: () async => _permission,
      requestPermission: () async => _permission,
      positionStream: (_) => gps.stream,
      currentPosition: (_) async {
        heartbeatRequests++;
        return _pos();
      },
      accelStream: () => accel.stream,
    );
    sub = service.fixes.listen(fixes.add);
  }

  final LocationPermission _permission;
  final gps = StreamController<Position>.broadcast(sync: true);
  final accel = StreamController<AccelerometerEvent>.broadcast(sync: true);
  final fixes = <Fix>[];
  int heartbeatRequests = 0;
  late final LocationService service;
  late final StreamSubscription<Fix> sub;

  Future<void> close() async {
    await sub.cancel();
    await gps.close();
    await accel.close();
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('LocationService acquisition path', () {
    test('start() with the app open goes active and delivers fixes', () async {
      final h = _Harness();
      await h.service.start();
      // A cold start with the app open must behave like a foreground resume:
      // active immediately, for a prompt first fix — not idle until motion
      // or the first 15-minute heartbeat.
      expect(h.service.activity, LocationActivity.active);
      expect(h.service.plan.gpsEnabled, isTrue);
      expect(h.gps.hasListener, isTrue);

      h.gps.add(_pos());
      await Future<void>.delayed(Duration.zero);
      expect(h.fixes, hasLength(1));
      expect(h.fixes.single.lat, 38.69);
      expect(h.fixes.single.lon, -90.43);
      await h.close();
    });

    test(
        'THE v1.2 WEDGE: a signed-out hard-stop must not survive the next '
        'session (setSharing(true) + start() delivers fixes again)', () async {
      final h = _Harness();
      // The signed-out branch hard-stops the engine…
      h.service.setSharing(sharing: false);
      // …and the next sign-in reaches start() with the machine still ghosted.
      await h.service.start();
      expect(h.service.plan.gpsEnabled, isFalse,
          reason: 'ghosted machine: start() alone must not override a ghost');
      expect(h.fixes, isEmpty);

      // The fix: session establishment resets sharing before the gate runs
      // start(). After it, fixes must flow again in the SAME process.
      h.service.setSharing(sharing: true);
      await h.service.start();
      expect(h.service.activity, LocationActivity.active);
      expect(h.service.plan.gpsEnabled, isTrue);
      h.gps.add(_pos());
      await Future<void>.delayed(Duration.zero);
      expect(h.fixes, hasLength(1));
      await h.close();
    });

    test('ghost stays a hard stop through repeat start()', () async {
      final h = _Harness();
      await h.service.start();
      h.service.setSharing(sharing: false);
      expect(h.service.plan.gpsEnabled, isFalse);
      expect(h.gps.hasListener, isFalse);
      // A repeat start (gate re-run) must not lift a live ghost choice.
      await h.service.start();
      expect(h.service.plan.gpsEnabled, isFalse);
      await h.close();
    });

    test('denied permission never touches the sensors', () async {
      final h = _Harness(permission: LocationPermission.denied);
      await h.service.start();
      expect(h.gps.hasListener, isFalse);
      expect(h.accel.hasListener, isFalse);
      await h.close();
    });

    test('stationary send loop: stillness ramps down, heartbeat keeps fixes '
        'flowing', () {
      fakeAsync((async) {
        final h = _Harness();
        unawaited(h.service.start());
        async.flushMicrotasks();
        expect(h.service.activity, LocationActivity.active);

        // A stationary fix arms the stillness timer…
        h.gps.add(_pos());
        async.flushMicrotasks();
        expect(h.fixes, hasLength(1));

        // …which ramps active → idle: GPS off, heartbeat armed.
        async.elapse(const Duration(seconds: 31));
        expect(h.service.activity, LocationActivity.idle);
        expect(h.gps.hasListener, isFalse);

        // The 15-minute heartbeat still reports presence.
        async.elapse(const Duration(minutes: 15));
        expect(h.heartbeatRequests, 1);
        expect(h.fixes, hasLength(2));
        unawaited(h.close());
        async.flushMicrotasks();
      });
    });
  });

  group('establishSessionEngineState', () {
    late LocationService engine;
    late _FakeApi api;

    Future<(WidgetTester, WidgetRef)> pump(
      WidgetTester tester, {
      bool goDarkDefault = false,
    }) async {
      FlutterSecureStorage.setMockInitialValues({
        'point.settings': jsonEncode(
          AppSettings(goDarkDefault: goDarkDefault).toJson(),
        ),
      });
      engine = LocationService(
        checkPermission: () async => LocationPermission.always,
        requestPermission: () async => LocationPermission.always,
        positionStream: (_) => const Stream<Position>.empty(),
        currentPosition: (_) async => _pos(),
        accelStream: () => const Stream<AccelerometerEvent>.empty(),
      );
      api = _FakeApi();
      late WidgetRef ref;
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            locationServiceProvider.overrideWithValue(engine),
            apiProvider.overrideWithValue(api),
            authControllerProvider.overrideWith(_FakeAuth.new),
          ],
          child: Consumer(
            builder: (context, r, _) {
              ref = r;
              return const SizedBox.shrink();
            },
          ),
        ),
      );
      // Ghost/go-dark act on the session; make sure auth has resolved.
      await ref.read(authControllerProvider.future);
      return (tester, ref);
    }

    testWidgets('clears a leftover signed-out hard-stop on session restore',
        (tester) async {
      final (_, ref) = await pump(tester);
      engine.setSharing(sharing: false); // the signed-out hard-stop
      await establishSessionEngineState(ref, explicitSignIn: false);
      expect(engine.plan.gpsEnabled, isTrue,
          reason: 'the wedge: a restored session must not inherit the '
              "previous sign-out's ghost");
      expect(api.ghostSetTo, isNull, reason: 'no go-dark → no server write');
    });

    testWidgets('explicit sign-in with go-dark default ends dark',
        (tester) async {
      final (_, ref) = await pump(tester, goDarkDefault: true);
      engine.setSharing(sharing: false);
      await establishSessionEngineState(ref, explicitSignIn: true);
      expect(engine.plan.gpsEnabled, isFalse,
          reason: 'go-dark default must win over the reset, sequenced');
      expect(api.ghostSetTo, isTrue, reason: 'ghost persisted to the server');
    });

    testWidgets('restore ignores the go-dark default (never overrides a live '
        'choice)', (tester) async {
      final (_, ref) = await pump(tester, goDarkDefault: true);
      engine.setSharing(sharing: false);
      await establishSessionEngineState(ref, explicitSignIn: false);
      expect(engine.plan.gpsEnabled, isTrue);
      expect(api.ghostSetTo, isNull);
    });
  });
}

const _session = Session(
  token: 't',
  userId: 'janet@point.petalcat.dev',
  displayName: 'Janet',
  isAdmin: false,
);

class _FakeAuth extends AuthController {
  @override
  Future<Session?> build() async => _session;
}

class _FakeApi implements PointApi {
  bool? ghostSetTo;

  @override
  Future<GhostState> getGhost(String token) async =>
      const GhostState(active: false);

  @override
  Future<GhostState> setGhost(String token, {required bool active}) async {
    ghostSetTo = active;
    return GhostState(active: active);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('${invocation.memberName}');
}
