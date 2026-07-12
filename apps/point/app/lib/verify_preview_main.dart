import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/crypto/crypto_service.dart';
import 'package:point_app/features/people/presentation/verify_sheet.dart';
import 'package:point_app/features/relay/relay_controller.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/theme/app_theme.dart';
import 'package:point_app/theme/presence_tokens.dart';

/// Craft-only render preview of the VerifySheet (Wave 7) with a fixed safety
/// number. The REAL cross-client safety number is proven by verify_check_main.
void main() {
  runApp(
    ProviderScope(
      overrides: [
        authControllerProvider.overrideWith(_Auth.new),
        cryptoServiceProvider.overrideWithValue(_FakeCrypto()),
      ],
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.dark(pureBlack: true),
        darkTheme: AppTheme.dark(pureBlack: true),
        themeMode: ThemeMode.dark,
        home: const Scaffold(
          body: VerifySheet(
            person: Person(
              userId: 'eli@point.petalcat.dev',
              displayName: 'Eli',
              presence: PresenceState.live,
            ),
          ),
        ),
      ),
    ),
  );
}

class _Auth extends AuthController {
  @override
  Future<Session?> build() async => const Session(
        userId: 'parker@point.petalcat.dev',
        token: 't',
        displayName: 'Parker H',
        isAdmin: true,
      );
}

class _FakeCrypto extends CryptoService {
  @override
  Future<String> safetyNumber(Uint8List groupId) async =>
      '39891 65113 05930 16880 35172 40996 88636 91750';
}
