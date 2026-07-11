import 'dart:developer' as developer;

import 'package:flutter/material.dart';
import 'package:point_app/features/location/data/location_service.dart';
import 'package:point_app/theme/app_theme.dart';

/// Instrumented entrypoint for the on-device battery / background soak (GO-bar
/// #1 measurement). It drives the REAL [LocationService] — real GPS, real
/// accelerometer wake-gate, real foreground service — and logs every fix and
/// every activity change to logcat (tag `POINT_SOAK`) with timestamps, so an
/// `adb logcat` capture yields the ground-truth cadence + reliability numbers.
/// Not a facade: this is the same engine the app uses.
void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const _SoakApp());
}

class _SoakApp extends StatefulWidget {
  const _SoakApp();

  @override
  State<_SoakApp> createState() => _SoakAppState();
}

class _SoakAppState extends State<_SoakApp> with WidgetsBindingObserver {
  final _service = LocationService();
  int _fixCount = 0;
  String _status = 'starting';
  bool _sharing = true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _service.fixes.listen((f) {
      _fixCount++;
      final line =
          'FIX ts=${DateTime.now().toIso8601String()} n=$_fixCount '
          'lat=${f.lat.toStringAsFixed(5)} lon=${f.lon.toStringAsFixed(5)} '
          'spd=${f.speed.toStringAsFixed(1)} acc=${f.accuracy.toStringAsFixed(0)} '
          'activity=${_service.activity.name} interval=${_service.plan.gpsInterval.inSeconds}s';
      developer.log(line, name: 'POINT_SOAK');
      if (mounted) setState(() => _status = line);
    });
    _start();
  }

  Future<void> _start() async {
    developer.log('START ts=${DateTime.now().toIso8601String()}',
        name: 'POINT_SOAK');
    await _service.start();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    developer.log('LIFECYCLE ${state.name} ts=${DateTime.now().toIso8601String()}',
        name: 'POINT_SOAK');
    switch (state) {
      case AppLifecycleState.resumed:
        _service.onForeground();
      case AppLifecycleState.paused:
      case AppLifecycleState.detached:
      case AppLifecycleState.hidden:
        _service.onBackground();
      case AppLifecycleState.inactive:
        break;
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _service.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: AppTheme.dark(),
      home: Scaffold(
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Text('Point — soak', style: AppTheme.dark().textTheme.headlineMedium),
                const SizedBox(height: 12),
                Text('fixes: $_fixCount'),
                const SizedBox(height: 8),
                Text(_status, style: const TextStyle(fontFamily: 'JetBrains Mono', fontSize: 11)),
                const SizedBox(height: 24),
                FilledButton(
                  onPressed: () {
                    _sharing = !_sharing;
                    _service.setSharing(sharing: _sharing);
                    developer.log(
                        'GHOST sharing=$_sharing ts=${DateTime.now().toIso8601String()}',
                        name: 'POINT_SOAK');
                    setState(() {});
                  },
                  child: Text(_sharing ? 'Go dark (ghost)' : 'Share'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
