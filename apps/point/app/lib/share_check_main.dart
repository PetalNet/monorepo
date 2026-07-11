import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:point_app/features/crypto/crypto_service.dart';
import 'package:point_app/features/relay/relay_queue.dart';
import 'package:point_app/features/relay/ws_service.dart';
import 'package:point_app/services/api/point_api.dart';
import 'package:point_app/src/rust/frb_generated.dart';

/// End-to-end verification of reliable direct sharing (GO-bar #4) against a
/// LIVE M0 server: two users, a POOL of one-time KeyPackages, share → claim →
/// MLS group → Welcome relay → an encrypted fix over the durable WS queue →
/// decrypt on the other side. Drives the whole real client↔server path (client
/// MLS via FRB + one-time KeyPackage consumption + WS relay). No mocks.
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await RustLib.init();
  final result = await _run();
  runApp(_ResultApp(result));
}

const _base = String.fromEnvironment('POINT_SERVER',
    defaultValue: 'http://localhost:8330');
String get _wsUrl => '${_base.replaceFirst('http', 'ws')}/ws';

Uint8List _u(String s) => Uint8List.fromList(utf8.encode(s));

Future<String> _run() async {
  final api = PointApi(baseUrl: _base);
  final suffix = DateTime.now().millisecondsSinceEpoch % 100000;
  try {
    // 1. Register two users on the live server.
    final alice = await api.register(
        username: 'ea$suffix', password: 'correcthorsebattery');
    final bob = await api.register(
        username: 'eb$suffix', password: 'correcthorsebattery');

    // 2. MLS identities; upload a POOL of KeyPackages each (multi-KP fix).
    final aliceMls = CryptoService();
    final bobMls = CryptoService();
    await aliceMls.init(alice.userId);
    await bobMls.init(bob.userId);
    Future<List<String>> pool(CryptoService c) async => [
          for (var i = 0; i < 3; i++)
            base64Encode(await c.generateKeyPackage()),
        ];
    await api.uploadKeyPackages(alice.token, await pool(aliceMls));
    await api.uploadKeyPackages(bob.token, await pool(bobMls));

    // 3. Share: Alice requests, Bob accepts.
    await api.sendShareRequest(alice.token, bob.userId);
    final reqs = await api.incomingRequests(bob.token);
    if (reqs.isEmpty) return 'FAIL: Bob saw no share request';
    await api.acceptRequest(bob.token, reqs.first.id);

    // 4. Alice claims ONE of Bob's KeyPackages, forms the pairwise group,
    //    adds Bob, and relays the Welcome via the server.
    final claim = await api.claimKeyPackage(alice.token, bob.userId);
    if (claim.lastResort) return 'FAIL: got last-resort (pool not consumed)';
    final gid = CryptoService.pairwiseGroupId(alice.userId, bob.userId);
    await aliceMls.createGroup(gid);
    final add = await aliceMls.addMember(gid, base64Decode(claim.keyPackage));
    final groupIdStr = utf8.decode(gid);
    await api.sendWelcome(
      alice.token,
      recipientId: bob.userId,
      groupId: groupIdStr,
      payload: base64Encode(add.welcome),
    );

    // 5. Bob pulls the Welcome and joins the group.
    final msgs = await api.mlsMessages(bob.token);
    final welcome = msgs.firstWhere(
      (m) => m['message_type'] == 'welcome',
      orElse: () => {},
    );
    if (welcome.isEmpty) return 'FAIL: Bob got no Welcome';
    final bobGid =
        await bobMls.processWelcome(base64Decode(welcome['payload'] as String));
    await api.ackMlsMessage(bob.token, welcome['id'] as String);

    // 6. Connect both over the durable WS; Bob listens for the broadcast.
    final aliceWs =
        WsService(wsUrl: _wsUrl, queue: RelayQueue(store: MemoryRelayStore()));
    final bobWs =
        WsService(wsUrl: _wsUrl, queue: RelayQueue(store: MemoryRelayStore()));
    final got = Completer<String>();
    bobWs.incoming.listen((m) async {
      if (m['type'] == 'location.broadcast' && !got.isCompleted) {
        try {
          final ct = base64Decode(m['blob'] as String);
          final pt = utf8.decode(await bobMls.decrypt(bobGid, ct));
          got.complete(pt);
        } on Object catch (e) {
          if (!got.isCompleted) got.complete('DECRYPT-ERR: $e');
        }
      }
    });
    await bobWs.start(bob.token);
    await aliceWs.start(alice.token);
    await Future<void>.delayed(const Duration(milliseconds: 800));

    // 7. Alice encrypts a fix for the pairwise group and relays it (via the
    //    durable queue) as a location.update targeting Bob.
    const fix = '{"lat":38.627,"lon":-90.199,"timestamp":1752000000000}';
    final ct = await aliceMls.encrypt(gid, _u(fix));
    final frame = jsonEncode({
      'type': 'location.update',
      'recipient_type': 'user',
      'recipient_id': bob.userId,
      'blob': base64Encode(ct),
      'timestamp': 1752000000000,
    });
    await aliceWs.send(bob.userId, frame);

    // 8. Bob should receive + decrypt Alice's fix.
    final received = await got.future.timeout(
      const Duration(seconds: 6),
      onTimeout: () => 'TIMEOUT: no broadcast received',
    );
    await aliceWs.dispose();
    await bobWs.dispose();
    api.close();

    if (received == fix) {
      return 'PASS: share → MLS group → encrypted fix over WS → decrypt';
    }
    return 'FAIL: got "$received"';
  } on Object catch (e) {
    return 'FAIL: $e';
  }
}

class _ResultApp extends StatelessWidget {
  const _ResultApp(this.result);
  final String result;

  @override
  Widget build(BuildContext context) {
    final ok = result.startsWith('PASS');
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      home: Scaffold(
        backgroundColor: Colors.black,
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(28),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  ok ? 'SHARE ✓' : 'SHARE ✗',
                  style: TextStyle(
                    color: ok ? Colors.white : Colors.redAccent,
                    fontSize: 44,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 16),
                Text(
                  result,
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: Colors.white70, fontSize: 12),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
