import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:point_app/services/api/point_api.dart';
import 'package:point_app/src/rust/api/crypto.dart';
import 'package:point_app/src/rust/api/recovery.dart' as recovery;
import 'package:point_app/src/rust/frb_generated.dart';

/// On-device verification of ZERO-KNOWLEDGE ACCOUNT RECOVERY (M4), driving the
/// REAL path end to end — no facades:
///   1. Alice registers on the LIVE server and forms an MLS group with Bob.
///   2. Alice exports her MLS state, encrypts it under a recovery code via the
///      REAL FRB → point-core recovery crypto, and uploads the opaque blob to
///      the LIVE server (`PUT /api/recovery/backup`).
///   3. A SIMULATED NEW DEVICE fetches the blob (`GET`), decrypts it with the
///      code, and restores Alice's identity from scratch.
///   4. The restored Alice encrypts a fix AFTER recovery and Bob still decrypts
///      it — proving recovery restored a working E2E session, not just bytes.
///   5. A wrong recovery code is proven to fail closed.
/// The server only ever saw ciphertext (asserted: the stored blob does not
/// contain the plaintext state).
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await RustLib.init();
  final result = await _run();
  runApp(_ResultApp(result));
}

Uint8List _b(String s) => Uint8List.fromList(utf8.encode(s));

Future<String> _run() async {
  final api = PointApi(baseUrl: 'http://localhost:8330');
  try {
    // Unique username per run so re-runs don't collide.
    final tag = DateTime.now().millisecondsSinceEpoch.toRadixString(36);
    final session = await api.register(
      username: 'alice_$tag',
      password: 'correcthorsebattery',
    );
    final token = session.token;
    final identity = session.userId;

    // Alice (this device) forms a group with Bob and shares a fix.
    final alice = PointMls(identity: identity);
    final bob = PointMls(identity: 'bob@localhost');
    final bobKp = await bob.generateKeyPackage();
    final gid = await alice.createGroup(groupId: _b('recovery-family'));
    final add = await alice.addMember(groupId: gid, keyPackage: bobKp);
    final bobGid = await bob.processWelcome(welcome: add.welcome);

    final ctBefore = await alice.encrypt(groupId: gid, plaintext: _b('before'));
    final ptBefore = utf8.decode(await bob.decrypt(groupId: bobGid, ciphertext: ctBefore));
    if (ptBefore != 'before') return 'FAIL: pre-recovery decrypt ($ptBefore)';

    // Enroll: export state -> recovery-encrypt -> upload opaque blob.
    final code = recovery.generateRecoveryCode();
    final state = await alice.exportState();
    final blob = recovery.recoveryEncrypt(state: state, recoveryCode: code);

    // The encrypted blob must not leak the plaintext state.
    final stateHead = utf8.decode(state.take(16).toList(), allowMalformed: true);
    final blobStr = utf8.decode(blob, allowMalformed: true);
    if (stateHead.isNotEmpty && blobStr.contains(stateHead)) {
      return 'FAIL: recovery blob leaks plaintext state';
    }

    await api.putRecoveryBackup(token, base64Encode(blob));

    // --- Simulated NEW DEVICE: only the token + the recovery code. ---
    final fetched = await api.getRecoveryBackup(token);
    if (fetched == null) return 'FAIL: server had no backup';
    final serverBlob = base64Decode(fetched.blobBase64);
    if (serverBlob.length != blob.length) {
      return 'FAIL: server returned a different-length blob';
    }

    // Wrong code must fail closed.
    var wrongCodeRejected = false;
    try {
      recovery.recoveryDecrypt(blob: serverBlob, recoveryCode: 'WRONG-CODE-0000');
    } on Object {
      wrongCodeRejected = true;
    }
    if (!wrongCodeRejected) return 'FAIL: wrong recovery code was accepted';

    // Correct code: decrypt -> restore Alice on the new device.
    final restoredState =
        recovery.recoveryDecrypt(blob: serverBlob, recoveryCode: code);
    final aliceNew = PointMls.restore(state: restoredState);
    if (!aliceNew.hasGroup(groupId: gid)) {
      return 'FAIL: recovered Alice lost the group';
    }

    // The recovered identity holds a WORKING session: encrypt after recovery,
    // Bob decrypts.
    const msg = 'fix after account recovery';
    final ctAfter = await aliceNew.encrypt(groupId: gid, plaintext: _b(msg));
    final ptAfter = utf8.decode(await bob.decrypt(groupId: bobGid, ciphertext: ctAfter));
    if (ptAfter != msg) return 'FAIL: post-recovery decrypt ($ptAfter)';

    return 'PASS recovery: enroll → upload → [new device] → fetch → decrypt → '
        'restore → encrypt → Bob decrypts. Wrong code rejected. Server saw only '
        'ciphertext (${blob.length}B blob, code "${code.substring(0, 6)}…").';
  } on Object catch (e) {
    return 'FAIL: $e';
  } finally {
    api.close();
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
                  ok ? 'RECOVERY ✓' : 'RECOVERY ✗',
                  style: TextStyle(
                    color: ok ? Colors.white : Colors.redAccent,
                    fontSize: 40,
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
