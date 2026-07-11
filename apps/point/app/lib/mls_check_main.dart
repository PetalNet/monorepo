import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:point_app/src/rust/api/crypto.dart';
import 'package:point_app/src/rust/frb_generated.dart';

/// On-device verification of MLS state durability (GO-bar #2). Drives the REAL
/// FRB → point-core path: Alice forms a group with Bob, exports her MLS state,
/// is "restarted" via restore(), and Bob still decrypts a message she encrypts
/// AFTER the restart — proving the E2E session survived a relaunch (the legacy
/// defect where MLS state was in-memory-only and broke on relaunch).
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await RustLib.init();
  final result = await _runCheck();
  runApp(_ResultApp(result));
}

Uint8List _b(String s) => Uint8List.fromList(utf8.encode(s));

Future<String> _runCheck() async {
  try {
    final alice = PointMls(identity: 'alice@point.local');
    final bob = PointMls(identity: 'bob@point.local');

    final bobKp = await bob.generateKeyPackage();
    final gid = await alice.createGroup(groupId: _b('family-group'));
    final add = await alice.addMember(groupId: gid, keyPackage: bobKp);
    final bobGid = await bob.processWelcome(welcome: add.welcome);

    // Before restart: sanity roundtrip.
    final ct0 = await alice.encrypt(groupId: gid, plaintext: _b('before'));
    final pt0 = utf8.decode(await bob.decrypt(groupId: bobGid, ciphertext: ct0));
    if (pt0 != 'before') return 'FAIL: pre-restart decrypt ($pt0)';

    // Export Alice's state, then RESTART her from the blob.
    final blob = await alice.exportState();
    final aliceRestored = PointMls.restore(state: blob);
    if (!aliceRestored.hasGroup(groupId: gid)) {
      return 'FAIL: restored Alice lost the group';
    }

    // After restart: encrypt from the RESTORED Alice; Bob must still decrypt.
    const msg = 'location after restart';
    final ct = await aliceRestored.encrypt(groupId: gid, plaintext: _b(msg));
    final ctStr = utf8.decode(ct, allowMalformed: true);
    final leaks = ctStr.contains(msg);
    final pt = utf8.decode(await bob.decrypt(groupId: bobGid, ciphertext: ct));

    if (pt != msg) return 'FAIL: post-restart decrypt ($pt)';
    if (leaks) return 'FAIL: ciphertext leaked plaintext';
    return 'PASS durability: encrypt->export->restore->decrypt (${blob.length}B state)';
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
                  ok ? 'MLS ✓' : 'MLS ✗',
                  style: TextStyle(
                    color: ok ? Colors.white : Colors.redAccent,
                    fontSize: 48,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 16),
                Text(
                  result,
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: Colors.white70, fontSize: 13),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
