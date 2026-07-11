import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/app/point_app.dart';
import 'package:point_app/src/rust/frb_generated.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Load the native MLS engine (point-core via flutter_rust_bridge).
  await RustLib.init();
  runApp(const ProviderScope(child: PointApp()));
}
