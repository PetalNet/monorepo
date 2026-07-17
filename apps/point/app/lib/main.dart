import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/app/point_app.dart';
import 'package:point_app/background_engine_main.dart';
import 'package:point_app/src/rust/frb_generated.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Load the native MLS engine (point-core via flutter_rust_bridge).
  await RustLib.init();
  // Defect #5 (R9): keep the boot-resume headless entrypoint's LIBRARY in the
  // release AOT. PointForegroundService reaches pointBackgroundMain ONLY by URI
  // — `DartEntrypoint('package:point_app/background_engine_main.dart',
  // 'pointBackgroundMain')` → Dart_LookupLibrary — from a headless engine after
  // an OS kill / reboot. Nothing else imports that library, and
  // @pragma('vm:entry-point') retains the FUNCTION but NOT its library for URI
  // lookup, so a release build tree-shook the library out and the lookup failed
  // ("library ... not found") — the phone showed "Sharing your location" while
  // dark. Importing it above plus this live reference from main() (the reachable
  // root) forces the library into the snapshot's library table so the URI
  // resolves. Read (not asserted — asserts are stripped in release AOT) so the
  // reference survives tree-shaking; the list is always non-empty so runApp runs.
  if (retainedBackgroundEntrypoints.isEmpty) return;
  runApp(const ProviderScope(child: PointApp()));
}
