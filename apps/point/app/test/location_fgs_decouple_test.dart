import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator/geolocator.dart';
import 'package:point_app/features/location/data/location_service.dart';
import 'package:point_app/features/location/domain/location_state_machine.dart';
import 'package:point_app/features/location/foreground_service.dart';
import 'package:sensors_plus/sensors_plus.dart';

/// DEFECT #2 — decoupling our foreground service from geolocator's cached
/// position stream. These are the go-dark/battery-blocker tests.
///
/// The position fake here MODELS geolocator_android's real behavior — it does
/// NOT hand back a fresh controller per call (which would hide the whole bug).
/// geolocator caches its stream and IGNORES new LocationSettings while a
/// listener is active (`if (_positionStream != null) return _positionStream!`);
/// the cache only resets when the LAST listener cancels
/// (`asBroadcastStream(onCancel: () => _positionStream = null)`). So the only
/// way adaptive cadence takes effect is a full cancel-then-reopen — and that is
/// exactly what the engine must do now, safely, because OUR own foreground
/// service holds the process foreground across the swap.
class _GeolocatorCacheFake {
  StreamController<Position>? _active;

  /// Settings actually applied to the platform (i.e. cache MISSES — a genuine
  /// reopen). A make-before-break swap would leave this at one entry forever.
  final applied = <AndroidSettings>[];
  int openCount = 0;

  /// Concurrently-live streams. Must never exceed 1 (no double GPS stream / no
  /// double battery). Cancel-then-reopen dips 1 → 0 → 1; a leak would show 2.
  int live = 0;
  int maxLive = 0;

  Stream<Position> call(LocationSettings settings) => stream(settings);

  Stream<Position> stream(LocationSettings settings) {
    if (_active != null) {
      // Cache HIT: geolocator returns the SAME stream and the new settings are
      // dropped on the floor. (Modeled faithfully — the crux of DEFECT #2.)
      return _active!.stream;
    }
    openCount++;
    applied.add(settings as AndroidSettings);
    final controller = StreamController<Position>.broadcast(
      onListen: () {
        live++;
        if (live > maxLive) maxLive = live;
      },
      onCancel: () {
        live--;
        _active = null; // last listener gone → geolocator resets its cache
      },
      sync: true,
    );
    _active = controller;
    return controller.stream;
  }

  void emit(Position p) => _active?.add(p);
}

class _FakeForegroundService implements ForegroundServiceController {
  int startCount = 0;
  int stopCount = 0;
  bool running = false;

  /// Defect #5: when true the platform REFUSES the next start(s) (Android-12
  /// background FGS-with-location block) — start() reports failure and the FGS
  /// does not come up, so the engine must re-arm instead of latching it running.
  bool refuseStart = false;

  final _promotions = StreamController<bool>.broadcast(sync: true);

  @override
  Stream<bool> get promotions => _promotions.stream;

  /// Defect #1-remnant: drive the async native `startForeground` PROMOTION
  /// result the engine now keys on (separate from the accepted start below).
  void emitPromotion({required bool promoted}) => _promotions.add(promoted);

  @override
  Future<bool> start() async {
    startCount++;
    if (refuseStart) return false;
    running = true;
    return true;
  }

  @override
  Future<void> stop() async {
    stopCount++;
    running = false;
  }
}

Position _pos({double speed = 0, int tsMs = 1752357600000}) => Position(
  latitude: 38.6,
  longitude: -90.4,
  timestamp: DateTime.fromMillisecondsSinceEpoch(tsMs),
  accuracy: 5,
  altitude: 0,
  altitudeAccuracy: 0,
  heading: 0,
  headingAccuracy: 0,
  speed: speed,
  speedAccuracy: 0,
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  ({LocationService service, _GeolocatorCacheFake geo, _FakeForegroundService fgs})
  build() {
    final geo = _GeolocatorCacheFake();
    final fgs = _FakeForegroundService();
    final service = LocationService(
      checkPermission: () async => LocationPermission.always,
      requestPermission: () async => LocationPermission.always,
      positionStream: geo.stream,
      currentPosition: (_) async => _pos(),
      accelStream: () => const Stream<AccelerometerEvent>.empty(),
      foregroundService: fgs,
    );
    return (service: service, geo: geo, fgs: fgs);
  }

  test('the fake is faithful: a re-listen while active returns the SAME stream '
      'and IGNORES new settings (geolocator cache-and-ignore)', () {
    final geo = _GeolocatorCacheFake();
    final s1 = geo.stream(
      AndroidSettings(intervalDuration: const Duration(seconds: 2)),
    );
    final sub = s1.listen((_) {});
    // A second call with DIFFERENT settings, listener still active → cache hit.
    geo.stream(AndroidSettings(intervalDuration: const Duration(seconds: 15)));
    expect(geo.openCount, 1, reason: 'no reopen while a listener is active');
    expect(geo.applied.single.intervalDuration, const Duration(seconds: 2));
    unawaited(sub.cancel());
  });

  test('(a) adaptive cadence ACTUALLY changes after the first fix — the engine '
      "cancels + reopens to defeat geolocator's settings cache", () {
    fakeAsync((async) {
      final h = build();
      unawaited(h.service.start());
      async.flushMicrotasks();

      // First open: foreground active — 2s / 0m / high.
      expect(h.geo.openCount, 1);
      expect(h.geo.applied.last.intervalDuration, const Duration(seconds: 2));
      expect(h.geo.applied.last.distanceFilter, 0);
      expect(h.geo.applied.last.accuracy, LocationAccuracy.high);
      // Geolocator runs NO foreground service of its own — we own it.
      expect(h.geo.applied.last.foregroundNotificationConfig, isNull);

      // A first fix arrives on the (cached) stream.
      h.geo.emit(_pos());
      async.flushMicrotasks();

      // Background → the cadence MUST change to 15s / 10m. This is the exact
      // transition geolocator's cache used to swallow (listener still alive →
      // old 2s kept → battery drain). Now it takes effect.
      h.service.onBackground();
      async.flushMicrotasks();
      expect(
        h.geo.openCount,
        2,
        reason: 'stream reopened (cancel-then-reopen) to change cadence',
      );
      expect(h.geo.applied.last.intervalDuration, const Duration(seconds: 15));
      expect(h.geo.applied.last.distanceFilter, 10);

      unawaited(h.service.dispose());
      async.flushMicrotasks();
    });
  });

  test('(b) our foreground service NEVER drops across parked↔active swaps and '
      'stream reopens (only ghost/dispose stop it)', () {
    fakeAsync((async) {
      final h = build();
      unawaited(h.service.start());
      async.flushMicrotasks();
      expect(h.fgs.running, isTrue);
      expect(h.fgs.startCount, 1);

      h.geo.emit(_pos());
      async.flushMicrotasks();

      // Foreground → background → back, plus a ramp to parked and a wake: many
      // stream reopens, but the FGS must stay up the entire time.
      h.service.onBackground();
      async.flushMicrotasks();
      h.service.onForeground();
      async.flushMicrotasks();
      h.service.onBackground();
      h.geo.emit(_pos());
      async
        ..flushMicrotasks()
        ..elapse(const Duration(seconds: 31)); // → idle (parked)
      expect(h.service.activity, LocationActivity.idle);

      expect(h.fgs.running, isTrue, reason: 'FGS survived every swap');
      expect(h.fgs.stopCount, 0);
      expect(h.geo.openCount, greaterThan(1), reason: 'streams did reopen');

      unawaited(h.service.dispose());
      async.flushMicrotasks();
    });
  });

  test('(c) no double GPS stream / no double battery — at most one live stream '
      'at any moment through all the swaps', () {
    fakeAsync((async) {
      final h = build();
      unawaited(h.service.start());
      async.flushMicrotasks();
      h.geo.emit(_pos());
      async
        ..flushMicrotasks()
        ..elapse(const Duration(seconds: 1));
      h.service.onBackground();
      async.flushMicrotasks();
      h.service.onForeground();
      async.flushMicrotasks();
      expect(
        h.geo.maxLive,
        1,
        reason: 'cancel-then-reopen never overlaps two live position streams',
      );
      unawaited(h.service.dispose());
      async.flushMicrotasks();
    });
  });

  test('R15: an active↔fast flip in the foreground does NOT reopen the stream '
      '(identical 2s/0m/high effective settings — no radio thrash), but a real '
      'cadence change (background) does', () {
    fakeAsync((async) {
      final h = build();
      unawaited(h.service.start());
      async.flushMicrotasks();
      expect(h.geo.openCount, 1);

      // Three sustained fast fixes promote active → fast. Fast foreground is the
      // SAME 2s/0m/high stream, so no reopen — a city stop-and-go must not
      // thrash the GPS radio for no cadence change.
      for (var i = 0; i < 3; i++) {
        h.geo.emit(_pos(speed: 10));
        async.flushMicrotasks();
      }
      expect(h.service.activity, LocationActivity.fast);
      expect(
        h.geo.openCount,
        1,
        reason: 'active↔fast in fg is the same effective stream — no reopen',
      );

      // Background: fast background is 10s/25m — a genuine change → reopen.
      h.service.onBackground();
      async.flushMicrotasks();
      expect(h.geo.openCount, 2);
      expect(h.geo.applied.last.intervalDuration, const Duration(seconds: 10));
      expect(h.geo.applied.last.distanceFilter, 25);

      unawaited(h.service.dispose());
      async.flushMicrotasks();
    });
  });

  test('Defect #1: a FIX-DRIVEN cadence change (background active→fast, >5 m/s) '
      'ACTUALLY reopens the stream. The reopen fires from inside the position '
      "callback; deferring it off that firing stack lets geolocator's onCancel "
      'reset its cache so the new cadence is honored (not the stale cached one)',
      () {
    fakeAsync((async) {
      final h = build();
      unawaited(h.service.start());
      async.flushMicrotasks();
      expect(h.geo.openCount, 1); // foreground active — 2s/0m/high

      // Background: active-bg is 15s/10m — a real cadence change (reopen #2),
      // driven from OUTSIDE any firing stack (the existing tests' blind spot).
      h.service.onBackground();
      async.flushMicrotasks();
      expect(h.geo.openCount, 2);
      expect(h.geo.applied.last.intervalDuration, const Duration(seconds: 15));
      expect(h.geo.applied.last.distanceFilter, 10);
      expect(h.service.activity, LocationActivity.active);

      // Three sustained >5 m/s fixes promote active→fast FROM WITHIN _onPosition
      // — the reopen therefore fires from inside the position stream's own event
      // dispatch. Dart defers a broadcast onCancel until firing ends, so a
      // synchronous cancel-then-reopen HERE would hand back geolocator's STALE
      // cached 15s/10m stream (the swallowed background cadence change). The
      // engine now defers the reconcile off the firing stack, so the reopen sees
      // the reset cache and honors the fast-bg 10s/25m cadence.
      for (var i = 0; i < 3; i++) {
        h.geo.emit(_pos(speed: 10, tsMs: 1752357600000 + i * 1000));
        async.flushMicrotasks();
      }
      expect(h.service.activity, LocationActivity.fast);
      expect(
        h.geo.openCount,
        3,
        reason: 'fix-driven active→fast reopened the stream (deferred off the '
            'firing stack); before the fix the cache swallowed it and it stuck '
            'at 2',
      );
      expect(h.geo.applied.last.intervalDuration, const Duration(seconds: 10));
      expect(h.geo.applied.last.distanceFilter, 25);
      expect(h.geo.maxLive, 1, reason: 'no double stream across the reopen');

      unawaited(h.service.dispose());
      async.flushMicrotasks();
    });
  });

  test('Defect #5: a REFUSED native FGS start is not latched as running — the '
      'engine re-arms and retries until the platform accepts it (no Doze '
      'go-dark believing a dead FGS is up)', () {
    fakeAsync((async) {
      final h = build();
      h.fgs.refuseStart = true; // Android-12 background FGS-start refused
      unawaited(h.service.start());
      async.flushMicrotasks();

      // Attempted but refused: the FGS is NOT running and NOT (wrongly) latched.
      // Before the fix the engine latched _fgsRunning=true before the async call
      // and never retried.
      expect(h.fgs.running, isFalse);
      expect(h.fgs.startCount, 1);

      // The OS now allows the start (app returned to foreground / window opened).
      // The re-arm backoff fires and the retry succeeds.
      h.fgs.refuseStart = false;
      async
        ..elapse(const Duration(seconds: 5))
        ..flushMicrotasks();
      expect(h.fgs.running, isTrue, reason: 're-armed and retried after refusal');
      expect(h.fgs.startCount, greaterThanOrEqualTo(2));

      unawaited(h.service.dispose());
      async.flushMicrotasks();
    });
  });

  test('Defect #1-remnant: an ACCEPTED start whose async startForeground '
      'PROMOTION is later REFUSED is NOT left latched — the engine un-latches '
      'and re-arms, then a CONFIRMED promotion stops the churn. (The accepted '
      'startForegroundService is not proof the service reached foreground.)', () {
    fakeAsync((async) {
      final h = build();
      unawaited(h.service.start());
      async.flushMicrotasks();
      // The start REQUEST was accepted — but that is the synchronous accept, not
      // the survival-critical promotion.
      expect(h.fgs.startCount, 1);

      // The async startForeground PROMOTION is then refused (the service stops
      // itself → FGS actually DOWN). The native side reports the failure; and a
      // retry keeps being refused until the OS window opens.
      h.fgs
        ..refuseStart = true
        ..emitPromotion(promoted: false);

      // Before the fix this was invisible to Dart (start() had already returned
      // true) so nothing re-armed and the engine believed a dead FGS was up.
      // Now it re-arms: the backoff fires and retries.
      async
        ..flushMicrotasks()
        ..elapse(const Duration(seconds: 5))
        ..flushMicrotasks();
      expect(h.fgs.startCount, greaterThanOrEqualTo(2),
          reason: 're-armed after the promotion refusal');

      // The OS now allows it: a CONFIRMED promotion latches and cancels the
      // re-arm — no unbounded churn once the survival service is truly up.
      h.fgs
        ..refuseStart = false
        ..emitPromotion(promoted: true);
      final settled = h.fgs.startCount;
      async
        ..elapse(const Duration(seconds: 30))
        ..flushMicrotasks();
      expect(h.fgs.startCount, settled,
          reason: 'a confirmed promotion stops the retries');

      unawaited(h.service.dispose());
      async.flushMicrotasks();
    });
  });

  test('Defect #2-new (R9 headless resume): a FGS marked externally-owned is '
      'never started/stopped/retried by the engine — no unbounded 5s wakeful '
      'churn behind the native service that already holds the foreground', () {
    fakeAsync((async) {
      final h = build();
      // Even a channel that would refuse (the headless engine has no FGS channel
      // registered) must never be touched once the FGS is externally-owned.
      h.fgs.refuseStart = true;
      h.service.markForegroundServiceExternallyOwned();
      unawaited(h.service.start());
      async
        ..flushMicrotasks()
        // Long past every 5s re-arm the old headless path would have spun.
        ..elapse(const Duration(minutes: 5))
        ..flushMicrotasks();

      expect(h.fgs.startCount, 0, reason: 'engine never starts its own FGS');
      expect(h.fgs.stopCount, 0);
      // The rest of the resume is unaffected — GPS still comes up.
      expect(h.geo.openCount, greaterThanOrEqualTo(1));

      unawaited(h.service.dispose());
      async.flushMicrotasks();
      // Dispose must not reach for the externally-owned FGS either.
      expect(h.fgs.stopCount, 0);
    });
  });
}
