import 'dart:async';
import 'dart:convert';

import 'package:fake_async/fake_async.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator/geolocator.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/app/session_transition.dart';
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
      positionStream: (settings) {
        lastGpsSettings = settings;
        gpsSettings.add(settings);
        return gps.stream;
      },
      currentPosition: (_) {
        heartbeatRequests++;
        // A parked provider that cannot get a fresh fix (indoors, Doze
        // throttled) must still fail toward relaying — the engine floors the
        // last-known position rather than going silent.
        if (heartbeatShouldThrow) {
          return Future<Position>.error(StateError('no fix'));
        }
        final c = Completer<Position>();
        pendingHeartbeats.add(c);
        if (autocompleteHeartbeats) c.complete(_pos());
        return c.future;
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
  bool autocompleteHeartbeats = true;
  bool heartbeatShouldThrow = false;
  final pendingHeartbeats = <Completer<Position>>[];
  // The settings the engine last opened / every open of the position stream —
  // lets a test read the applied accuracy + foreground-service config.
  LocationSettings? lastGpsSettings;
  final gpsSettings = <LocationSettings>[];
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

    test('THE v1.2 WEDGE: a signed-out hard-stop must not survive the next '
        'session (setSharing(true) + start() delivers fixes again)', () async {
      final h = _Harness();
      // The signed-out branch hard-stops the engine…
      h.service.setSharing(sharing: false);
      // …and the next sign-in reaches start() with the machine still ghosted.
      await h.service.start();
      expect(
        h.service.plan.gpsEnabled,
        isFalse,
        reason: 'ghosted machine: start() alone must not override a ghost',
      );
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
      expect(h.service.currentHealth.status, LocationHealthStatus.blocked);
      expect(
        h.service.currentHealth.failure,
        LocationHealthFailure.permissionDenied,
      );
      await h.close();
    });

    test('health recovers from a GPS failure after a fresh fix', () async {
      final h = _Harness();
      await h.service.start();
      expect(h.service.currentHealth.status, LocationHealthStatus.acquiring);

      h.gps.addError(StateError('provider unavailable'));
      await Future<void>.delayed(Duration.zero);
      expect(h.service.currentHealth.status, LocationHealthStatus.blocked);
      expect(h.service.currentHealth.failure, LocationHealthFailure.gps);

      final recovered = _pos();
      h.gps.add(recovered);
      await Future<void>.delayed(Duration.zero);
      expect(h.service.currentHealth.status, LocationHealthStatus.live);
      expect(h.service.currentHealth.failure, isNull);
      expect(h.service.currentHealth.lastFixAt, recovered.timestamp);
      await h.close();
    });

    test(
      'pre-start lifecycle/sharing events never touch the sensors',
      () async {
        final h = _Harness();
        // Before start() clears the permission gate, foreground/sharing events
        // may only update the machine — no plugin pokes before onboarding has
        // earned the ask.
        h.service.onForeground();
        h.service.setSharing(sharing: true);
        expect(h.gps.hasListener, isFalse);
        expect(h.accel.hasListener, isFalse);
        await h.close();
      },
    );

    test('stationary send loop: stillness ramps down to a LOW-power stream '
        '(FGS kept alive), heartbeat keeps fixes flowing', () {
      fakeAsync((async) {
        final h = _Harness();
        unawaited(h.service.start());
        async.flushMicrotasks();
        expect(h.service.activity, LocationActivity.active);

        // A stationary fix arms the stillness timer…
        h.gps.add(_pos());
        async.flushMicrotasks();
        expect(h.fixes, hasLength(1));

        // …which ramps active → idle. The high-power GPS radio backs off, but
        // the position stream STAYS OPEN at low power: geolocator only runs the
        // Android foreground service while a stream is live, and that service is
        // the only thing that keeps Doze from freezing the isolate (tracker
        // 733 — used to `_stopGps()` here and go dark).
        async.elapse(const Duration(seconds: 31));
        expect(h.service.activity, LocationActivity.idle);
        expect(h.gps.hasListener, isTrue);
        expect(h.lastGpsSettings!.accuracy, LocationAccuracy.low);
        expect(
          (h.lastGpsSettings! as AndroidSettings).foregroundNotificationConfig,
          isNotNull,
          reason: 'the FGS keep-alive must survive going parked',
        );

        // The 5-minute hard floor still reports presence.
        async.elapse(const Duration(minutes: 5));
        expect(h.heartbeatRequests, 1);
        expect(h.fixes, hasLength(2));
        unawaited(h.close());
        async.flushMicrotasks();
      });
    });

    test('a heartbeat in flight when ghost lands must not leak the fix', () {
      fakeAsync((async) {
        final h = _Harness()..autocompleteHeartbeats = false;
        unawaited(h.service.start());
        async.flushMicrotasks();
        h.gps.add(_pos());
        async
          ..flushMicrotasks()
          ..elapse(const Duration(seconds: 31)) // → idle, heartbeat armed
          ..elapse(const Duration(minutes: 5)); // heartbeat request opens
        expect(h.pendingHeartbeats, hasLength(1));
        final before = h.fixes.length;

        // Go dark while the position request is STILL in flight…
        h.service.setSharing(sharing: false);
        h.pendingHeartbeats.single.complete(_pos());
        async.flushMicrotasks();

        // …and the late fix must be dropped, not emitted to the relay.
        expect(h.fixes, hasLength(before));
        unawaited(h.close());
        async.flushMicrotasks();
      });
    });

    test('active without a single fix ramps down instead of pinning GPS', () {
      fakeAsync((async) {
        final h = _Harness();
        unawaited(h.service.start());
        async.flushMicrotasks();
        expect(h.service.activity, LocationActivity.active);

        // No fix ever arrives (indoors): the acquisition window must close
        // rather than hold HIGH-power GPS forever. It ramps to idle and drops
        // to a low-power stream — it does not keep pinning high-accuracy GPS.
        async.elapse(const Duration(seconds: 31));
        expect(h.service.activity, LocationActivity.idle);
        expect(h.gps.hasListener, isTrue);
        expect(h.lastGpsSettings!.accuracy, LocationAccuracy.low);
        unawaited(h.close());
        async.flushMicrotasks();
      });
    });

    test('THE DOZE REGRESSION: backgrounded + perfectly still keeps the '
        'foreground service alive and relays on a periodic floor', () {
      fakeAsync((async) {
        final h = _Harness();
        unawaited(h.service.start());
        async.flushMicrotasks();

        // One real fix, then the app is backgrounded and the person sits still
        // (sitting at work all day — the owner's actual symptom).
        h.gps.add(_pos());
        async.flushMicrotasks();
        h.service.onBackground();
        async
          ..flushMicrotasks()
          ..elapse(const Duration(seconds: 31)); // stillness → idle
        expect(h.service.activity, LocationActivity.idle);

        // The foreground-service position stream MUST stay open — it is the
        // Doze exemption. Under the old engine this was torn down and the phone
        // went dark for hours.
        expect(h.gps.hasListener, isTrue);
        expect(
          (h.lastGpsSettings! as AndroidSettings).foregroundNotificationConfig,
          isNotNull,
        );

        // Perfectly still: the low-power stream emits nothing (distanceFilter),
        // yet a relay must still leave the device on the ~5-minute floor…
        final afterIdle = h.fixes.length;
        async.elapse(const Duration(minutes: 5));
        expect(h.fixes.length, afterIdle + 1);
        // …and keep leaving, floor after floor, for the whole still stretch.
        async.elapse(const Duration(minutes: 5));
        expect(h.fixes.length, afterIdle + 2);
        async.elapse(const Duration(minutes: 5));
        expect(h.fixes.length, afterIdle + 3);

        unawaited(h.close());
        async.flushMicrotasks();
      });
    });

    test('the floor fails toward relaying: a failed fresh fix still re-relays '
        'the last-known position (never goes dark)', () {
      fakeAsync((async) {
        final h = _Harness();
        unawaited(h.service.start());
        async.flushMicrotasks();

        final seed = _pos(lat: 38.70, lon: -90.44);
        h.gps.add(seed);
        async
          ..flushMicrotasks()
          ..elapse(const Duration(seconds: 31)); // → idle
        expect(h.service.activity, LocationActivity.idle);

        // The provider can no longer get a fresh fix (indoors / throttled).
        h.heartbeatShouldThrow = true;
        final before = h.fixes.length;
        async
          ..elapse(const Duration(minutes: 5))
          ..flushMicrotasks();

        // A relay STILL leaves — the last-known position, re-stamped now, so a
        // viewer keeps seeing the person instead of a dark dot.
        expect(h.fixes.length, before + 1);
        final floored = h.fixes.last;
        expect(floored.lat, seed.latitude);
        expect(floored.lon, seed.longitude);
        expect(floored.timestampMs, greaterThan(seed.timestamp.millisecondsSinceEpoch));

        unawaited(h.close());
        async.flushMicrotasks();
      });
    });
  });

  group('sessionTransition (the _onAuth decision, D-028)', () {
    const janet = Session(
      token: 't',
      userId: 'janet@point.petalcat.dev',
      displayName: 'Janet',
      isAdmin: false,
    );

    test('first resolution to a session establishes', () {
      expect(
        sessionTransition(
          establishedUserId: null,
          prev: const AsyncLoading<Session?>(),
          next: const AsyncData<Session?>(janet),
        ),
        SessionTransition.establish,
      );
    });

    test('loading → data(SAME user) refresh is a skip — never re-establish '
        '(re-establishing could lift a live ghost choice)', () {
      expect(
        sessionTransition(
          establishedUserId: janet.userId,
          prev: const AsyncLoading<Session?>(),
          next: const AsyncData<Session?>(janet),
        ),
        SessionTransition.skip,
      );
    });

    test('same-user re-emission (display-name update) is a skip', () {
      expect(
        sessionTransition(
          establishedUserId: janet.userId,
          prev: const AsyncData<Session?>(janet),
          next: const AsyncData<Session?>(janet),
        ),
        SessionTransition.skip,
      );
    });

    test('sign-out tears down; the repeat signed-out emission skips', () {
      expect(
        sessionTransition(
          establishedUserId: janet.userId,
          prev: const AsyncData<Session?>(janet),
          next: const AsyncData<Session?>(null),
        ),
        SessionTransition.teardown,
      );
      expect(
        sessionTransition(
          establishedUserId: null,
          prev: const AsyncData<Session?>(null),
          next: const AsyncData<Session?>(null),
        ),
        SessionTransition.skip,
      );
    });

    test('THE WEDGE: sign-out → sign-in of the SAME account re-establishes '
        '(teardown cleared the established identity)', () {
      // After teardown, establishedUserId is null — so the same account
      // signing back in MUST establish (lifting the signed-out hard-stop).
      expect(
        sessionTransition(
          establishedUserId: null,
          prev: const AsyncData<Session?>(null),
          next: const AsyncData<Session?>(janet),
        ),
        SessionTransition.establish,
      );
    });

    test('loading emissions are skips', () {
      expect(
        sessionTransition(
          establishedUserId: janet.userId,
          prev: const AsyncData<Session?>(janet),
          next: const AsyncLoading<Session?>(),
        ),
        SessionTransition.skip,
      );
    });

    test('SessionTracker sequence: teardown CLEARS the identity so the same '
        'account re-establishes (deleting the clear = the wedge returns)', () {
      final tracker = SessionTracker();
      const signedIn = AsyncData<Session?>(janet);
      const signedOut = AsyncData<Session?>(null);

      expect(
        tracker.onEmission(const AsyncLoading<Session?>(), signedIn),
        SessionTransition.establish,
      );
      // Same-user refresh mid-session: never re-establish (ghost preserved).
      expect(
        tracker.onEmission(const AsyncLoading<Session?>(), signedIn),
        SessionTransition.skip,
      );
      expect(
        tracker.onEmission(signedIn, signedOut),
        SessionTransition.teardown,
      );
      // THE WEDGE: the SAME account signing back in must establish again —
      // this fails if teardown stops clearing the tracked identity.
      expect(
        tracker.onEmission(signedOut, signedIn),
        SessionTransition.establish,
      );
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

    testWidgets('clears a leftover signed-out hard-stop on session restore', (
      tester,
    ) async {
      final (_, ref) = await pump(tester);
      engine.setSharing(sharing: false); // the signed-out hard-stop
      await establishSessionEngineState(ref, explicitSignIn: false);
      expect(
        engine.plan.gpsEnabled,
        isTrue,
        reason:
            'the wedge: a restored session must not inherit the '
            "previous sign-out's ghost",
      );
      expect(api.ghostSetTo, isNull, reason: 'no go-dark → no server write');
    });

    testWidgets('explicit sign-in with go-dark default ends dark', (
      tester,
    ) async {
      final (_, ref) = await pump(tester, goDarkDefault: true);
      engine.setSharing(sharing: false);
      await establishSessionEngineState(ref, explicitSignIn: true);
      expect(
        engine.plan.gpsEnabled,
        isFalse,
        reason: 'go-dark default must win over the reset, sequenced',
      );
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

    testWidgets('a FAILED go-dark write never rolls the engine back to '
        'broadcasting (fail-closed)', (tester) async {
      final (_, ref) = await pump(tester, goDarkDefault: true);
      api.failSetGhost = true;
      await establishSessionEngineState(ref, explicitSignIn: true);
      // The user asked to start dark; the server write failing must leave
      // the engine dark, not silently resume broadcasting.
      expect(engine.plan.gpsEnabled, isFalse);
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
  bool failSetGhost = false;

  @override
  Future<GhostState> getGhost(String token) async =>
      const GhostState(active: false);

  @override
  Future<GhostState> setGhost(String token, {required bool active}) async {
    if (failSetGhost) throw Exception('server unreachable');
    ghostSetTo = active;
    return GhostState(active: active);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('${invocation.memberName}');
}
