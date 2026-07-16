import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/location/location_providers.dart';
import 'package:point_app/features/relay/relay_controller.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/src/rust/frb_generated.dart';

/// R9 — the background/boot re-establishment entrypoint.
///
/// `PointForegroundService` executes this via a headless Flutter engine after an
/// OS memory-kill (START_STICKY) or a reboot (`BootReceiver`) when there was an
/// active share, so a killed/rebooted phone resumes sharing WITHOUT the user
/// reopening the app. It rehydrates the persisted session and, if one exists,
/// re-drives the same establishment the UI gate does: lift any leftover ghost,
/// start the battery engine, and start the relay so fixes leave the device.
///
/// Kept OUT of the widget tree deliberately — there is no UI here. It reuses the
/// app's own providers (a headless [ProviderContainer]) so there is one engine
/// implementation, not a background fork that can drift.
///
/// Must stay annotated `@pragma('vm:entry-point')`: it is torn off the main
/// isolate graph and reached only by name from the native engine host, so the
/// tree-shaker would otherwise drop it.
@pragma('vm:entry-point')
void pointBackgroundMain() {
  unawaited(_run());
}

Future<void> _run() async {
  WidgetsFlutterBinding.ensureInitialized();
  // The native MLS engine (point-core via flutter_rust_bridge) — the relay
  // encrypts every fix through it, so it must be loaded before the relay starts.
  try {
    await RustLib.init();
  } on Object catch (e) {
    if (kDebugMode) debugPrint('background: RustLib.init failed: $e');
    return;
  }

  final container = ProviderContainer();
  try {
    final session = await container.read(sessionStoreProvider).read();
    if (session == null) {
      // Signed out since the share flag was written — nothing to resume.
      return;
    }
    // Lift any leftover signed-out hard-stop and start the battery engine.
    final engine = container.read(locationServiceProvider)
      ..setSharing(sharing: true);
    await engine.start();
    // Start the relay so the engine's fixes are encrypted and sent. A cold
    // restore must never override a live sharing choice, which is exactly what
    // resuming an ACTIVE share is here.
    await container.read(relayControllerProvider).start(session);
  } on Object catch (e) {
    if (kDebugMode) debugPrint('background: engine re-establish failed: $e');
  }
  // The container is intentionally left alive: it owns the running engine +
  // relay for the lifetime of the headless isolate (the foreground service
  // keeps the process up).
}
