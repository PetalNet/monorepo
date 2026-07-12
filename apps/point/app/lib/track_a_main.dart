import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:point_app/features/crypto/crypto_service.dart';
import 'package:point_app/features/relay/relay_queue.dart';
import 'package:point_app/features/relay/ws_service.dart';
import 'package:point_app/services/api/point_api.dart';
import 'package:point_app/src/rust/frb_generated.dart';

/// Account A = THIS PHONE. The real "is tracking working" proof (Parker's bar):
/// A produces LIVE GPS fixes, MLS-encrypts each, and relays them to account B
/// (a separate synthetic client, `tests/tracking_e2e.rs`) over the real WS path.
/// After [_fixCount] live fixes, A goes GHOST and keeps trying to send [_ghost
/// seqs] more — the server must drop those, so B must receive none of them.
///
/// Rendezvous with B is by a shared RUNID (compile-time --dart-define): A is
/// `tracka_$RUNID`, B is `trackb_$RUNID`. B registers first and uploads its
/// KeyPackages; A claims one and forms the pairwise MLS group.
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await RustLib.init();
  runApp(const _TrackApp());
}

const _base =
    String.fromEnvironment('POINT_SERVER', defaultValue: 'http://localhost:8330');
const _runId = String.fromEnvironment('RUNID', defaultValue: 'dev');
const _fixCount = int.fromEnvironment('FIX_COUNT', defaultValue: 5);
const _ghostCount = int.fromEnvironment('GHOST_COUNT', defaultValue: 2);
String get _wsUrl => '${_base.replaceFirst('http', 'ws')}/ws';

Uint8List _u(String s) => Uint8List.fromList(utf8.encode(s));

class _TrackApp extends StatefulWidget {
  const _TrackApp();
  @override
  State<_TrackApp> createState() => _TrackAppState();
}

class _TrackAppState extends State<_TrackApp> {
  final _log = <String>[];
  String _status = 'starting…';
  bool _done = false;
  bool _ok = false;

  @override
  void initState() {
    super.initState();
    unawaited(_run());
  }

  void _line(String s) {
    if (mounted) setState(() => _log.add(s));
  }

  void _set(String s) {
    if (mounted) setState(() => _status = s);
  }

  Future<Position> _fix() async {
    // A live GPS fix from the phone's real hardware.
    try {
      return await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: Duration(seconds: 15),
        ),
      );
    } on Object {
      final last = await Geolocator.getLastKnownPosition();
      if (last != null) return last;
      rethrow;
    }
  }

  Future<void> _run() async {
    final api = PointApi(baseUrl: _base);
    try {
      // Location permission for real GPS.
      var perm = await Geolocator.checkPermission();
      if (perm == LocationPermission.denied) {
        perm = await Geolocator.requestPermission();
      }
      _line('permission: $perm');

      // A registers and uploads a KeyPackage pool.
      final a = await api.register(
          username: 'tracka_$_runId', password: 'correcthorsebattery');
      const bId = 'trackb_$_runId@localhost';
      _line('A=${a.userId}  ->  B=$bId');
      final mls = CryptoService();
      await mls.init(a.userId);
      await api.uploadKeyPackages(a.token, [
        for (var i = 0; i < 3; i++) base64Encode(await mls.generateKeyPackage()),
      ]);

      // Share with B, then wait until B has accepted (authz needs the share).
      _set('sharing with B…');
      await api.sendShareRequest(a.token, bId);
      var shared = false;
      for (var i = 0; i < 60 && !shared; i++) {
        final active = await api.activeShares(a.token);
        shared = active.any((s) => (s['user_id'] ?? s['peer_id']) == bId) ||
            active.isNotEmpty;
        if (!shared) await Future<void>.delayed(const Duration(seconds: 1));
      }
      _line('share active: $shared');

      // Claim B's KeyPackage (retry until B has uploaded), form the pairwise
      // group, add B, and relay the Welcome.
      _set('forming MLS group…');
      ({String keyPackage, bool lastResort})? claim;
      for (var i = 0; i < 60 && claim == null; i++) {
        try {
          claim = await api.claimKeyPackage(a.token, bId);
        } on Object {
          await Future<void>.delayed(const Duration(seconds: 1));
        }
      }
      if (claim == null) throw StateError('could not claim B KeyPackage');
      final gid = CryptoService.pairwiseGroupId(a.userId, bId);
      await mls.createGroup(gid);
      final add = await mls.addMember(gid, base64Decode(claim.keyPackage));
      await api.sendWelcome(
        a.token,
        recipientId: bId,
        groupId: utf8.decode(gid),
        payload: base64Encode(add.welcome),
      );
      _line('Welcome sent → B');

      // Connect the real WS relay.
      final ws =
          WsService(wsUrl: _wsUrl, queue: RelayQueue(store: MemoryRelayStore()));
      await ws.start(a.token);
      await Future<void>.delayed(const Duration(seconds: 1));

      Future<void> relay(int seq, Position p) async {
        final fix = jsonEncode({
          'seq': seq,
          'lat': p.latitude,
          'lon': p.longitude,
          'ts': DateTime.now().millisecondsSinceEpoch,
        });
        final ct = await mls.encrypt(gid, _u(fix));
        await ws.send(
          bId,
          jsonEncode({
            'type': 'location.update',
            'recipient_type': 'user',
            'recipient_id': bId,
            'blob': base64Encode(ct),
            'timestamp': DateTime.now().millisecondsSinceEpoch,
          }),
        );
      }

      // Stream live GPS fixes to B.
      _set('streaming live GPS → B');
      for (var seq = 1; seq <= _fixCount; seq++) {
        final p = await _fix();
        await relay(seq, p);
        _line('sent seq=$seq (${p.latitude.toStringAsFixed(5)}, '
            '${p.longitude.toStringAsFixed(5)})');
        await Future<void>.delayed(const Duration(seconds: 2));
      }

      // GO GHOST. Then keep trying to send — the server must drop these.
      _set('GHOST on — sending decoys');
      await api.setGhost(a.token, active: true);
      _line('ghost = ON');
      for (var k = 1; k <= _ghostCount; k++) {
        final seq = _fixCount + k;
        final p = await _fix();
        await relay(seq, p);
        _line('sent seq=$seq AFTER ghost (server should drop)');
        await Future<void>.delayed(const Duration(seconds: 2));
      }

      await ws.dispose();
      api.close();
      _ok = true;
      _set('DONE — A sent $_fixCount live fixes, then ghosted + sent '
          '$_ghostCount decoys');
    } on Object catch (e) {
      _set('ERROR: $e');
    } finally {
      if (mounted) setState(() => _done = true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final good = _done && _ok;
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      home: Scaffold(
        backgroundColor: Colors.black,
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  good ? 'A: SENT ✓' : (_done ? 'A: DONE' : 'A: TRACKING…'),
                  style: TextStyle(
                    color: good ? Colors.white : Colors.white70,
                    fontSize: 30,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 8),
                Text(_status,
                    style:
                        const TextStyle(color: Colors.tealAccent, fontSize: 13)),
                const SizedBox(height: 12),
                Expanded(
                  child: ListView(
                    children: [
                      for (final l in _log)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 2),
                          child: Text(l,
                              style: const TextStyle(
                                  color: Colors.white60, fontSize: 12)),
                        ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
