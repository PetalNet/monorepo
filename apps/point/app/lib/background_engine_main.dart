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

/// Defect #5 (R9) tree-shake retention anchor. `@pragma('vm:entry-point')`
/// retains [pointBackgroundMain] the FUNCTION, but the native side looks it up
/// by LIBRARY URI (`Dart_LookupLibrary('package:point_app/background_engine_main.dart')`),
/// and a library with no members reachable from a root gets dropped from the
/// release AOT — the lookup then fails and the boot-resume never runs (the phone
/// shows "Sharing your location" while dark). `main.dart` imports this library
/// and reads this list, giving the library a live reference from the reachable
/// root so it stays in the snapshot's library table. Holds the entrypoint
/// tear-off so the reference cannot be constant-folded away.
@pragma('vm:entry-point')
final List<void Function()> retainedBackgroundEntrypoints = <void Function()>[
  pointBackgroundMain,
];

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
    // Defect #3: this is a HEADLESS resume — there is no UI, so the engine must
    // run at the BACKGROUND cadence. Without this, the machine's default
    // (foreground:true) makes start() jump to active-foreground (2s / 0m / high
    // accuracy) — max-drain GPS behind a dark screen. onBackground() before
    // start() flips it so start() applies the background plan instead of the
    // foreground one (start() only jumps to active when it's still foreground).
    final engine = container.read(locationServiceProvider)
      ..setSharing(sharing: true)
      ..onBackground();
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
