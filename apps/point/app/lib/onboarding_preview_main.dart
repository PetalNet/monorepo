import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:point_app/app/routes.dart';
import 'package:point_app/features/auth/presentation/login_screen.dart';
import 'package:point_app/features/ghost/ghost_controller.dart';
import 'package:point_app/features/me/presentation/about_screen.dart';
import 'package:point_app/features/me/presentation/account_screen.dart';
import 'package:point_app/features/me/presentation/identity_screen.dart';
import 'package:point_app/features/me/presentation/look_feel_screen.dart';
import 'package:point_app/features/me/presentation/me_screen.dart';
import 'package:point_app/features/me/presentation/notifications_settings_screen.dart';
import 'package:point_app/features/me/presentation/privacy_settings_screen.dart';
import 'package:point_app/features/onboarding/presentation/distributor_guide_screen.dart';
import 'package:point_app/features/onboarding/presentation/location_permission_screen.dart';
import 'package:point_app/features/onboarding/presentation/privacy_fork_screen.dart';
import 'package:point_app/features/onboarding/presentation/recovery_save_screen.dart';
import 'package:point_app/features/onboarding/presentation/server_pick_screen.dart';
import 'package:point_app/features/recovery/recovery_service.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/api/point_api.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/theme/app_theme.dart';

/// Craft-only render preview of the onboarding screens (Wave A), for the
/// web screenshot loop: `flutter build web -t lib/onboarding_preview_main.dart`
/// then open `/?screen=server|login|recovery|privacy|distributor|location`.
/// Platform channels are faked where needed; the REAL flow is verified
/// on-device.
void main() {
  final screen = Uri.base.queryParameters['screen'] ?? 'server';
  // A minimal kaisel router hosts the one previewed screen so `context.push`
  // and `context.router` resolve (navigation is an inert dead-end here).
  final config = KaiselRouterConfig<AppRoute>(
    initial: const SplashRoute(),
    builder: (context, route) => switch (screen) {
      'login' => const LoginScreen(),
      'recovery' => const RecoverySaveScreen(),
      'privacy' => const PrivacyForkScreen(),
      'distributor' => const DistributorGuideScreen(),
      'location' => const LocationPermissionScreen(),
      'me' => const MeScreen(),
      'privacy-settings' => const PrivacySettingsScreen(),
      'look' => const LookFeelScreen(),
      'notifications' => const NotificationsSettingsScreen(),
      'account' => const AccountScreen(),
      'about' => const AboutScreen(),
      'identity' => const IdentityScreen(),
      _ => const ServerPickScreen(),
    },
  );
  runApp(
    ProviderScope(
      overrides: [
        authControllerProvider.overrideWith(_Auth.new),
        recoveryServiceProvider.overrideWith(_FakeRecovery.new),
        ghostControllerProvider.overrideWith(_FakeGhost.new),
        apiProvider.overrideWith((ref) => _FakeApi()),
      ],
      child: MaterialApp.router(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.dark(pureBlack: true),
        darkTheme: AppTheme.dark(pureBlack: true),
        themeMode: ThemeMode.dark,
        routerConfig: config,
      ),
    ),
  );
}

class _Auth extends AuthController {
  @override
  Future<Session?> build() async => const Session(
    userId: 'parker@point.petalcat.dev',
    token: 'preview-token',
    displayName: 'Parker H',
    isAdmin: false,
  );
}

/// Deterministic phrase, no network, no Rust bridge.
class _FakeRecovery extends RecoveryService {
  _FakeRecovery(super._ref);

  @override
  Future<String?> cachedCode(String identity) async =>
      '4WPNVJ-M3H1KD-8XQ2TS-5RGZC9';
}

/// Broadcasting, no network.
class _FakeGhost extends GhostController {
  @override
  Future<GhostState> build() async => const GhostState(active: false);
}

/// No network in the preview: the recovery screen's backup probe sees a
/// stored backup so the cached-phrase path renders.
class _FakeApi extends PointApi {
  _FakeApi() : super(baseUrl: 'http://preview.invalid');

  @override
  Future<({String blobBase64, String updatedAt})?> getRecoveryBackup(
    String token,
  ) async => (blobBase64: '', updatedAt: '');

  @override
  Future<MeProfile> getMe(String token) async => const MeProfile(
    userId: 'parker@point.petalcat.dev',
    displayName: 'Parker H',
    whoCanAddMe: 'anyone',
    hasAvatar: false,
    ghostActive: false,
  );

  @override
  Future<Uint8List?> fetchAvatar(String token, String userId) async => null;
}
