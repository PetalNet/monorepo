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
import 'package:point_app/features/location/foreground_service.dart';
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

/// Records our own foreground-service start/stop calls (DEFECT #2). `running`
/// is the invariant the tests watch: it must go true when sharing begins and
/// STAY true across every parked↔active transition and GPS-stream reopen — only
/// ghost / dispose may drop it.
class _FakeForegroundService implements ForegroundServiceController {
  int startCount = 0;
  int stopCount = 0;
  bool running = false;

  final _promotions = StreamController<bool>.broadcast();

  @override
  Stream<bool> get promotions => _promotions.stream;

  @override
  Future<bool> start() async {
    startCount++;
    running = true;
    return true;
  }

  @override
  Future<void> stop() async {
    stopCount++;
    running = false;
  }
}

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
      foregroundService: fgs,
    );
    sub = service.fixes.listen(fixes.add);
  }

  final LocationPermission _permission;
  final fgs = _FakeForegroundService();
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

        // …which ramps active → idle after the DOCUMENTED foreground stillness
        // window (2min — location-strategy ACTIVE→SLEEPING "2min (fg)"). The
        // high-power GPS radio backs off, but the position stream STAYS OPEN at
        // low power: geolocator only runs the Android foreground service while a
        // stream is live, and that service is the only thing that keeps Doze
        // from freezing the isolate (tracker 733 — used to `_stopGps()` here
        // and go dark).
        async.elapse(const Duration(minutes: 2, seconds: 1));
        expect(h.service.activity, LocationActivity.idle);
        expect(h.gps.hasListener, isTrue);
        expect(h.lastGpsSettings!.accuracy, LocationAccuracy.low);
        expect(
          h.fgs.running,
          isTrue,
          reason: 'our own foreground service must survive going parked',
        );
        expect(
          (h.lastGpsSettings! as AndroidSettings).foregroundNotificationConfig,
          isNull,
          reason: 'geolocator runs no FGS of its own — DEFECT #2, we own it',
        );

        // R7: entering parked relays an IMMEDIATE keepalive (no currentPosition
        // request — a floor of the last-known) so there's no dark gap before the
        // first 30-minute timer. That's the 2nd fix, and it must NOT have burned
        // a heartbeat request.
        expect(h.fixes, hasLength(2));
        expect(h.heartbeatRequests, 0);
        expect(h.fixes.last.parked, isTrue);

        // The DOCUMENTED 30-minute parked heartbeat then reports presence (R1 —
        // Parker's 1.2.12 value; 1.2.11 shipped 15min).
        async.elapse(const Duration(minutes: 30));
        expect(h.heartbeatRequests, 1);
        expect(h.fixes, hasLength(3));
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
          ..elapse(const Duration(minutes: 2, seconds: 1)) // → idle, hb armed
          ..elapse(const Duration(minutes: 30)); // heartbeat request opens
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
        // rather than hold HIGH-power GPS forever. After the foreground
        // stillness window (2min) it ramps to idle and drops to a low-power
        // stream — it does not keep pinning high-accuracy GPS.
        async.elapse(const Duration(minutes: 2, seconds: 1));
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

        // Backgrounded, then one real fix, then the person sits still (sitting
        // at work all day — the owner's actual symptom). Backgrounding before
        // the fix arms the DOCUMENTED background stillness (30s — the fast kill
        // for "Still (no zone)" in the Layer 3 background table).
        h.service.onBackground();
        h.gps.add(_pos());
        async
          ..flushMicrotasks()
          ..elapse(const Duration(seconds: 31)); // background stillness → idle
        expect(h.service.activity, LocationActivity.idle);

        // The low-power position stream MUST stay open and our own foreground
        // service MUST still be running — it is the Doze exemption. Under the
        // old engine the survival service was torn down and the phone went dark
        // for hours.
        expect(h.gps.hasListener, isTrue);
        expect(h.fgs.running, isTrue);
        expect(
          (h.lastGpsSettings! as AndroidSettings).foregroundNotificationConfig,
          isNull,
          reason: 'geolocator runs no FGS of its own — DEFECT #2',
        );

        // R7: entering parked already relayed an immediate keepalive (so there's
        // no dark gap before the first timer). Count from AFTER that…
        final afterIdle = h.fixes.length;
        // …then the low-power stream emits nothing (distanceFilter), yet a relay
        // must still leave the device on the DOCUMENTED 30-minute heartbeat
        // floor, keeping-alive over the whole still stretch.
        async.elapse(const Duration(minutes: 30));
        expect(h.fixes.length, afterIdle + 1);
        async.elapse(const Duration(minutes: 30));
        expect(h.fixes.length, afterIdle + 2);
        async.elapse(const Duration(minutes: 30));
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
          ..elapse(const Duration(minutes: 2, seconds: 1)); // → idle (fg 2min)
        expect(h.service.activity, LocationActivity.idle);

        // The provider can no longer get a fresh fix (indoors / throttled).
        h.heartbeatShouldThrow = true;
        final before = h.fixes.length;
        async
          ..elapse(const Duration(minutes: 30))
          ..flushMicrotasks();

        // A relay STILL leaves so the viewer keeps seeing the person — but as a
        // PARKED keepalive (R2): the last-known position at its REAL sample time
        // (NOT re-stamped to now), with the liveness clock advanced to now. That
        // is the 1.2.11 go-dark fix — a dead phone can no longer masquerade as
        // "live, at home".
        expect(h.fixes.length, before + 1);
        final floored = h.fixes.last;
        expect(floored.lat, seed.latitude);
        expect(floored.lon, seed.longitude);
        expect(
          floored.timestampMs,
          seed.timestamp.millisecondsSinceEpoch,
          reason: 'position time is the REAL sample time, never faked to now',
        );
        expect(
          floored.aliveAtMs,
          greaterThan(seed.timestamp.millisecondsSinceEpoch),
          reason: 'liveness advances to now, separately from position',
        );
        expect(floored.parked, isTrue);

        unawaited(h.close());
        async.flushMicrotasks();
      });
    });

    test('LAYER 1 wake-gate hysteresis: a single accelerometer bump does NOT '
        'wake GPS; ~10s of SUSTAINED motion does (location-strategy Layer 1)',
        () {
      fakeAsync((async) {
        final h = _Harness();
        unawaited(h.service.start());
        async.flushMicrotasks();

        // Park it (backgrounded + still) so the accelerometer wake-gate is the
        // thing arbitrating GPS. The FGS-keepalive stream keeps the isolate
        // awake, so the accel gate runs in the background too.
        h.service.onBackground();
        h.gps.add(_pos());
        async
          ..flushMicrotasks()
          ..elapse(const Duration(seconds: 31)); // → idle, accel armed
        expect(h.service.activity, LocationActivity.idle);
        expect(h.accel.hasListener, isTrue);

        // A well-above-threshold sample (|magnitude| ≫ 1.2g): z well past 1g.
        AccelerometerEvent motion() =>
            AccelerometerEvent(0, 0, 9.81 + 6, DateTime.now());

        // A lone bump must be ignored (pocket jitter) — no wake. Elapse PAST
        // the full 10s sustained window: an impl with no grace-gap reset would
        // let a lone bump's wake timer mature at 10s and fire here. The real
        // engine cancels the accrual once the 2s grace gap passes with no
        // further motion, so it must STILL be idle at 12s.
        h.accel.add(motion());
        async.elapse(const Duration(seconds: 12)); // well past the 10s window
        expect(
          h.service.activity,
          LocationActivity.idle,
          reason: 'a single bump must not wake GPS even 12s later (the grace '
              'gap resets the accrual)',
        );

        // Pin the 10s threshold — low side: ~8s of SUSTAINED motion (a sample
        // each second, gaps < the 2s grace) is below the window and must NOT
        // wake.
        for (var i = 0; i < 8; i++) {
          h.accel.add(motion());
          async.elapse(const Duration(seconds: 1));
        }
        expect(
          h.service.activity,
          LocationActivity.idle,
          reason: '~8s of sustained motion is below the 10s wake threshold',
        );

        // Pin the 10s threshold — high side: carrying the SAME uninterrupted
        // burst past ~10s DOES wake.
        for (var i = 0; i < 3; i++) {
          h.accel.add(motion());
          async.elapse(const Duration(seconds: 1));
        }
        expect(
          h.service.activity,
          LocationActivity.active,
          reason: 'sustained motion reaching ~10s wakes GPS to active',
        );

        unawaited(h.close());
        async.flushMicrotasks();
      });
    });

    test('LAYER 1 hysteresis: periodic jitter (a bump every ~9s) never wakes — '
        'isolated samples with >2s still gaps keep resetting the accrual', () {
      fakeAsync((async) {
        final h = _Harness();
        unawaited(h.service.start());
        async.flushMicrotasks();

        // Same parked setup: backgrounded + still, accel gate arbitrating GPS.
        h.service.onBackground();
        h.gps.add(_pos());
        async
          ..flushMicrotasks()
          ..elapse(const Duration(seconds: 31)); // → idle, accel armed
        expect(h.service.activity, LocationActivity.idle);
        expect(h.accel.hasListener, isTrue);

        AccelerometerEvent motion() =>
            AccelerometerEvent(0, 0, 9.81 + 6, DateTime.now());

        // One bump every ~9s: each sample lands < the 10s wake window from the
        // last (so an impl that never resets its accrual would mature its timer
        // between bumps and wake), but the > 2s still gap between them resets
        // the accrual every time — so it must NEVER accumulate to a wake.
        for (var i = 0; i < 6; i++) {
          h.accel.add(motion());
          async.elapse(const Duration(seconds: 9));
          // Never WAKES (to active). It may ramp deeper to sleeping (R16) — that
          // is not a wake — so assert only that jitter never promotes to active.
          expect(
            h.service.activity,
            isNot(LocationActivity.active),
            reason: 'periodic jitter (a bump every ~9s) must never wake GPS',
          );
        }

        unawaited(h.close());
        async.flushMicrotasks();
      });
    });

    test('DOCUMENTED stillness windows: foreground rams down after 2min, '
        'background after 30s (location-strategy ACTIVE→SLEEPING)', () {
      fakeAsync((async) {
        // Foreground: 30s of stillness is NOT enough (2min window).
        final fg = _Harness();
        unawaited(fg.service.start());
        fg.gps.add(_pos());
        async
          ..flushMicrotasks()
          ..elapse(const Duration(seconds: 31));
        expect(
          fg.service.activity,
          LocationActivity.active,
          reason: 'foreground stillness is 2min — 31s must NOT ramp down',
        );
        async.elapse(const Duration(minutes: 2));
        expect(fg.service.activity, LocationActivity.idle);
        unawaited(fg.close());
        async.flushMicrotasks();

        // Background: 30s of stillness DOES ramp active → idle (fast kill near
        // Doze). Let start() settle to active-foreground FIRST, then background,
        // so this exercises the active→idle demotion (not an already-idle
        // machine that would ramp straight to sleeping).
        final bg = _Harness();
        unawaited(bg.service.start());
        async.flushMicrotasks();
        bg.service.onBackground();
        bg.gps.add(_pos());
        async
          ..flushMicrotasks()
          ..elapse(const Duration(seconds: 31));
        expect(bg.service.activity, LocationActivity.idle);
        unawaited(bg.close());
        async.flushMicrotasks();
      });
    });

    test('R8: foregrounding does NOT cancel the parked heartbeat — a person '
        'indoors with no GPS fix who reopens the app still gets a keepalive '
        '(the old engine canceled it on every foreground → unbounded dark)', () {
      fakeAsync((async) {
        final h = _Harness();
        unawaited(h.service.start()); // active; heartbeat armed at t=0
        async.flushMicrotasks();
        h.gps.add(_pos());
        async
          ..flushMicrotasks()
          ..elapse(const Duration(minutes: 2, seconds: 1)); // → idle (parked)
        expect(h.service.activity, LocationActivity.idle);
        expect(h.heartbeatRequests, 0, reason: 'no heartbeat has fired yet');

        // Reopen the app (→ active). The OLD engine canceled the heartbeat here,
        // so it never matured and the phone went dark; it must keep running.
        h.service.onForeground();

        // No GPS fix ever arrives (indoors). Cross the 30-minute heartbeat:
        // because foreground didn't cancel it, it fires.
        async.elapse(const Duration(minutes: 30));
        expect(
          h.heartbeatRequests,
          greaterThanOrEqualTo(1),
          reason: 'the heartbeat survived the foreground and fired',
        );

        unawaited(h.close());
        async.flushMicrotasks();
      });
    });

    test('R14 wake-gate is ~1.2 m/s²: sustained 0.8 m/s² (which the old '
        'squared-vs-linear gate wrongly fired at ~0.6) must NOT wake; 2.0 m/s² '
        'does', () {
      fakeAsync((async) {
        final h = _Harness();
        unawaited(h.service.start());
        async.flushMicrotasks();
        h.service.onBackground();
        h.gps.add(_pos());
        async
          ..flushMicrotasks()
          ..elapse(const Duration(seconds: 31)); // → idle, accel armed
        expect(h.service.activity, LocationActivity.idle);

        // 0.8 m/s² of LINEAR excess (z = g + 0.8). The old gate compared |a|²−g²
        // (= ~16, well over its 1.2·g ≈ 11.8) so it woke on a buzzing desk; the
        // fixed linear gate (|a|−g = 0.8 < 1.2) must NOT wake, even sustained.
        AccelerometerEvent weak() =>
            AccelerometerEvent(0, 0, 9.81 + 0.8, DateTime.now());
        for (var i = 0; i < 14; i++) {
          h.accel.add(weak());
          async.elapse(const Duration(seconds: 1));
        }
        expect(
          h.service.activity,
          LocationActivity.idle,
          reason: '0.8 m/s² is below the ~1.2 m/s² wake threshold',
        );

        // 2.0 m/s² linear excess IS above threshold → sustained motion wakes.
        AccelerometerEvent strong() =>
            AccelerometerEvent(0, 0, 9.81 + 2.0, DateTime.now());
        for (var i = 0; i < 11; i++) {
          h.accel.add(strong());
          async.elapse(const Duration(seconds: 1));
        }
        expect(h.service.activity, LocationActivity.active);

        unawaited(h.close());
        async.flushMicrotasks();
      });
    });

    test('R16: a parked device ramps idle → SLEEPING (60s), it is not left '
        'stuck in IDLE polling at 30s (which doubled the parked wakes)', () {
      fakeAsync((async) {
        final h = _Harness();
        unawaited(h.service.start());
        async.flushMicrotasks();
        h.service.onBackground();
        h.gps.add(_pos());
        async
          ..flushMicrotasks()
          ..elapse(const Duration(seconds: 31)); // active → idle (bg stillness)
        expect(h.service.activity, LocationActivity.idle);

        // The idle branch must RE-ARM stillness so it demotes to sleeping — the
        // old engine armed stillness only while moving, so idle was terminal.
        async.elapse(const Duration(seconds: 31));
        expect(
          h.service.activity,
          LocationActivity.sleeping,
          reason: 'idle must re-arm stillness and reach sleeping',
        );

        unawaited(h.close());
        async.flushMicrotasks();
      });
    });

    test('(e) entering parked relays an IMMEDIATE keepalive so there is no dark '
        'gap before the first 30-minute heartbeat', () {
      fakeAsync((async) {
        final h = _Harness();
        unawaited(h.service.start());
        async.flushMicrotasks();
        final seed = _pos(lat: 38.71, lon: -90.45);
        h.gps.add(seed);
        async.flushMicrotasks();
        final beforePark = h.fixes.length; // the live fix

        // Ramp to parked (fg stillness 2min). No heartbeat has fired yet.
        async.elapse(const Duration(minutes: 2, seconds: 1));
        expect(h.service.activity, LocationActivity.idle);

        // A keepalive left IMMEDIATELY on parking — before the first 30-min
        // tick — as a PARKED floor of the last-known position (real sample
        // time), costing no currentPosition request.
        expect(h.fixes.length, beforePark + 1);
        expect(h.heartbeatRequests, 0);
        final ka = h.fixes.last;
        expect(ka.parked, isTrue);
        expect(ka.lat, seed.latitude);
        expect(ka.timestampMs, seed.timestamp.millisecondsSinceEpoch);
        expect(ka.aliveAtMs, greaterThanOrEqualTo(ka.timestampMs));

        unawaited(h.close());
        async.flushMicrotasks();
      });
    });

    test('(f) DEFECT #2: a parked→active wake in the BACKGROUND swaps the GPS '
        'stream CANCEL-THEN-REOPEN (old canceled BEFORE new opened, to reset '
        "geolocator's settings cache) while OUR foreground service never drops "
        '(so the reopen never trips the Android-12 background FGS block)', () {
      fakeAsync((async) {
        final events = <String>[];
        final accel = StreamController<AccelerometerEvent>.broadcast(sync: true);
        final opened = <StreamController<Position>>[];
        final fgs = _FakeForegroundService();
        final service = LocationService(
          checkPermission: () async => LocationPermission.always,
          requestPermission: () async => LocationPermission.always,
          positionStream: (settings) {
            final c = StreamController<Position>.broadcast(
              onCancel: () => events.add('cancel'),
              sync: true,
            );
            opened.add(c);
            events.add('listen');
            return c.stream;
          },
          currentPosition: (_) async => _pos(),
          accelStream: () => accel.stream,
          foregroundService: fgs,
        );
        unawaited(service.start());
        async.flushMicrotasks();
        expect(fgs.running, isTrue, reason: 'FGS up as soon as sharing starts');

        // Park it in the background: one real fix (arms the 30s background
        // stillness) then sit still → idle.
        service.onBackground();
        opened.last.add(_pos());
        async
          ..flushMicrotasks()
          ..elapse(const Duration(seconds: 31));
        expect(service.activity, LocationActivity.idle);
        expect(events, contains('listen'));

        // Observe only the wake transition.
        events.clear();
        AccelerometerEvent motion() =>
            AccelerometerEvent(0, 0, 9.81 + 6, DateTime.now());
        // ~11s of sustained motion crosses the 10s wake gate.
        for (var i = 0; i < 11; i++) {
          accel.add(motion());
          async.elapse(const Duration(seconds: 1));
        }
        async.flushMicrotasks();
        expect(
          service.activity,
          LocationActivity.active,
          reason: 'sustained motion wakes GPS to active',
        );

        // CANCEL-THEN-REOPEN: the old stream is CANCELED before the replacement
        // is opened — the reverse of the old make-before-break — because
        // geolocator ignores new settings while a listener is active, so we must
        // drop to zero listeners (cache resets) first. Safe now only because our
        // own FGS keeps the process foreground the whole time.
        final cancelAt = events.indexOf('cancel');
        final listenAt = events.indexOf('listen');
        expect(cancelAt, isNonNegative, reason: 'the old stream was canceled');
        expect(listenAt, isNonNegative, reason: 'a replacement stream opened');
        expect(
          cancelAt,
          lessThan(listenAt),
          reason: 'cancel-then-reopen: old down BEFORE new up (cache reset)',
        );

        // The whole time, our foreground service never dropped.
        expect(fgs.running, isTrue);
        expect(fgs.stopCount, 0, reason: 'FGS must never stop across a wake');

        unawaited(service.dispose());
        unawaited(accel.close());
        async.flushMicrotasks();
      });
    });

    test('ghost stops our foreground service; leaving ghost restarts it', () {
      fakeAsync((async) {
        final h = _Harness();
        unawaited(h.service.start());
        async.flushMicrotasks();
        expect(h.fgs.running, isTrue);

        h.service.setSharing(sharing: false); // ghost
        expect(h.fgs.running, isFalse, reason: 'ghost is the one FGS drop');
        expect(h.fgs.stopCount, 1);

        h.service.setSharing(sharing: true); // un-ghost
        async.flushMicrotasks();
        expect(h.fgs.running, isTrue, reason: 'sharing again restarts the FGS');

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
