import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:point_app/src/rust/api/crypto.dart';
import 'package:point_app/src/rust/frb_generated.dart';

/// On-device verification of the SAFETY NUMBER (Wave 7), driving the REAL FRB →
/// point-core path: two identities form an MLS group and must compute the SAME
/// safety number (so two real phones can compare out-of-band), a different pair
/// must differ, and it must be stable across calls.
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await RustLib.init();
  runApp(_ResultApp(await _run()));
}

Uint8List _b(String s) => Uint8List.fromList(utf8.encode(s));

Future<String> _run() async {
  try {
    final alice = PointMls(identity: 'alice@point.local');
    final bob = PointMls(identity: 'bob@point.local');
    final bobKp = await bob.generateKeyPackage();
    final gid = await alice.createGroup(groupId: _b('verify-family'));
    final add = await alice.addMember(groupId: gid, keyPackage: bobKp);
    final bobGid = await bob.processWelcome(welcome: add.welcome);

    final aNum = await alice.safetyNumber(groupId: gid);
    final bNum = await bob.safetyNumber(groupId: bobGid);
    if (aNum != bNum) return 'FAIL: peers disagree\nA=$aNum\nB=$bNum';
    if (aNum.split(' ').length != 8) return 'FAIL: format ($aNum)';
    if (aNum != await alice.safetyNumber(groupId: gid)) {
      return 'FAIL: not stable';
    }

    // A different pair must differ.
    final carol = PointMls(identity: 'carol@point.local');
    final carolKp = await carol.generateKeyPackage();
    final gid2 = await alice.createGroup(groupId: _b('verify-other'));
    final add2 = await alice.addMember(groupId: gid2, keyPackage: carolKp);
    await carol.processWelcome(welcome: add2.welcome);
    if (aNum == await alice.safetyNumber(groupId: gid2)) {
      return 'FAIL: different pair matched';
    }

    return 'PASS safety number: both peers match + stable + pair-unique\n$aNum';
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
                  ok ? 'VERIFY ✓' : 'VERIFY ✗',
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
                  style: const TextStyle(color: Colors.white70, fontSize: 14),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
