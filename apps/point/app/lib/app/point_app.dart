import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:point_app/app/animated_branch_stack.dart';
import 'package:point_app/app/routes.dart';
import 'package:point_app/app/shell_chrome.dart';
import 'package:point_app/features/auth/presentation/login_screen.dart';
import 'package:point_app/features/auth/presentation/splash_screen.dart';
import 'package:point_app/features/device_link/presentation/device_link_screen.dart';
import 'package:point_app/features/ghost/ghost_controller.dart';
import 'package:point_app/features/ghost/presentation/ghost_screen.dart';
import 'package:point_app/features/location/location_providers.dart';
import 'package:point_app/features/map/presentation/map_screen.dart';
import 'package:point_app/features/me/presentation/about_screen.dart';
import 'package:point_app/features/me/presentation/account_screen.dart';
import 'package:point_app/features/me/presentation/identity_screen.dart';
import 'package:point_app/features/me/presentation/look_feel_screen.dart';
import 'package:point_app/features/me/presentation/me_screen.dart';
import 'package:point_app/features/me/presentation/notifications_settings_screen.dart';
import 'package:point_app/features/me/presentation/privacy_settings_screen.dart';
import 'package:point_app/features/me/presentation/recovery_screen.dart';
import 'package:point_app/features/onboarding/onboarding_flow.dart';
import 'package:point_app/features/onboarding/onboarding_gate.dart';
import 'package:point_app/features/onboarding/presentation/distributor_guide_screen.dart';
import 'package:point_app/features/onboarding/presentation/location_permission_screen.dart';
import 'package:point_app/features/onboarding/presentation/privacy_fork_screen.dart';
import 'package:point_app/features/onboarding/presentation/recovery_save_screen.dart';
import 'package:point_app/features/onboarding/presentation/server_pick_screen.dart';
import 'package:point_app/features/people/invite.dart';
import 'package:point_app/features/people/presentation/add_person_screen.dart';
import 'package:point_app/features/people/presentation/people_screen.dart';
import 'package:point_app/features/people/presentation/person_detail_screen.dart';
import 'package:point_app/features/people/temp_shares_controller.dart';
import 'package:point_app/features/push/push_service.dart';
import 'package:point_app/features/relay/relay_controller.dart';
import 'package:point_app/features/settings/app_settings.dart';
import 'package:point_app/features/settings/haptics.dart';
import 'package:point_app/features/settings/settings_controller.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/services/server_config.dart';
import 'package:point_app/theme/app_theme.dart';
import 'package:point_app/theme/theme_x.dart';

class PointApp extends ConsumerStatefulWidget {
  const PointApp({super.key});

  @override
  ConsumerState<PointApp> createState() => _PointAppState();
}

class _PointAppState extends ConsumerState<PointApp>
    with WidgetsBindingObserver {
  late final KaiselRouterConfig<AppRoute> _config;
  final AppLinks _appLinks = AppLinks();
  StreamSubscription<Uri>? _linkSub;

  @override
  void initState() {
    super.initState();
    // GO-bar #1: actually wire the app-lifecycle → background hooks the legacy
    // defined but never called. Without this the battery engine never learns
    // it's been backgrounded and location silently stops.
    WidgetsBinding.instance.addObserver(this);
    // Wire the UnifiedPush receiver callbacks once, at startup.
    unawaited(ref.read(pushServiceProvider).init());
    final loggedIn = ref.read(authControllerProvider.notifier).loggedIn;
    _config = KaiselRouterConfig<AppRoute>(
      initial: const SplashRoute(),
      guards: [_authGuard(loggedIn)],
      pageWrapper: _pageWrapper,
      builder: _pageForRoute,
    );
    // Invite deep links (point://add/<handle> and .../add/<handle>): the link
    // the app was launched from, plus any received while running.
    unawaited(
      _appLinks.getInitialLink().then((uri) {
        if (!mounted || uri == null) return;
        _onInviteLink(uri);
      }),
    );
    _linkSub = _appLinks.uriLinkStream.listen(_onInviteLink);
  }

  @override
  void dispose() {
    unawaited(_linkSub?.cancel());
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  void _onInviteLink(Uri uri) {
    final handle = handleFromInvite(uri);
    if (handle == null || handle.isEmpty) return;
    // Open the add flow only from a fully set-up shell; otherwise hold the
    // handle so it survives sign-in AND any onboarding steps in between.
    final signedIn = ref.read(authControllerProvider).value != null;
    if (signedIn && _config.router.stack.any((r) => r is MainShell)) {
      _config.router.set([
        const MainShell(),
        AddPersonRoute(prefillHandle: handle),
      ]);
    } else {
      ref.read(pendingInviteProvider.notifier).hold(handle);
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final engine = ref.read(locationServiceProvider);
    switch (state) {
      case AppLifecycleState.resumed:
        engine.onForeground();
        // The force-uncompleted gate, on every return to the app: if a
        // required step regressed while we were away (location revoked in
        // Android settings), route back into that step rather than sit in a
        // half-working shell.
        unawaited(_regateOnResume());
      case AppLifecycleState.paused:
      case AppLifecycleState.detached:
      case AppLifecycleState.hidden:
        engine.onBackground();
      case AppLifecycleState.inactive:
        break;
    }
  }

  /// Privacy setting "start each sign-in dark": a NEW session begins with
  /// sharing off until the user flips it, applied only when the setting says
  /// so and only on a real sign-in (never a restore, which would override a
  /// live choice on every launch).
  Future<void> _applyGoDarkDefault() async {
    final settings = await ref.read(settingsProvider.notifier).loaded;
    if (!settings.goDarkDefault || !mounted) return;
    await ref.read(ghostControllerProvider.notifier).setSharing(sharing: false);
  }

  /// The signed-out stack. A fresh install (no server ever chosen) starts at
  /// the server-pick step; a device with a choice starts at sign-in, with
  /// server pick one "back" behind it.
  Future<void> _routeSignedOut() async {
    final picked = await ref.read(serverUrlProvider.notifier).hasSavedChoice();
    if (!mounted) return;
    // A sign-in that landed while the storage read was in flight wins; this
    // stale signed-out stack must not clobber it.
    if (ref.read(authControllerProvider).value != null) return;
    await _config.router.set([
      const ServerPickRoute(),
      if (picked) const LoginRoute(),
    ]);
  }

  /// Re-run the launch gate on foreground, but only interrupt a settled
  /// shell: onboarding screens re-check themselves, and login/splash have
  /// nothing to gate.
  Future<void> _regateOnResume() async {
    final session = ref.read(authControllerProvider).value;
    if (session == null) return;
    if (!_config.router.stack.any((r) => r is MainShell)) return;
    final gate = ref.read(onboardingGateProvider);
    final step = await gate.firstIncomplete(session);
    if (step == null || !mounted) return;
    await continueOnboarding(ref, _config.router);
  }

  /// Backstop guard for deep links: any authed route while signed out becomes
  /// the sign-in stack (server pick beneath login, so "back" can change
  /// server). Primary auth-driven routing is the `router.set` listener below.
  KaiselGuard<AppRoute> _authGuard(ValueListenable<bool> loggedIn) {
    return (current, proposed) {
      final needsAuth = proposed.any(routeRequiresAuth);
      if (needsAuth && !loggedIn.value) {
        return const [ServerPickRoute(), LoginRoute()];
      }
      return proposed;
    };
  }

  /// The Look & feel motion setting, resolved against the OS accessibility
  /// flag when set to follow the system. Read at transition/switch time.
  bool get _reducedMotion => switch (ref.read(settingsProvider).motion) {
    MotionPreference.reduced => true,
    MotionPreference.full => false,
    MotionPreference.system =>
      WidgetsBinding
          .instance
          .platformDispatcher
          .accessibilityFeatures
          .disableAnimations,
  };

  /// Route-pair transitions (the acceptance-bar `pageWrapper`): full-screen
  /// modals (Ghost, Device-link) slide up; everything else fades.
  Page<Object?> _pageWrapper(KaiselPageWrapperContext<AppRoute> ctx) {
    return switch (ctx.route) {
      GhostRoute() ||
      DeviceLinkRoute() ||
      PersonDetailRoute() ||
      AddPersonRoute() ||
      SettingsPrivacyRoute() ||
      SettingsLookRoute() ||
      SettingsNotificationsRoute() ||
      SettingsAccountRoute() ||
      SettingsAboutRoute() ||
      IdentityRoute() ||
      RecoveryRoute() => _SlideUpPage(
        key: ctx.key,
        reduced: _reducedMotion,
        child: ctx.child,
      ),
      _ => _FadePage(key: ctx.key, reduced: _reducedMotion, child: ctx.child),
    };
  }

  Widget _pageForRoute(BuildContext context, AppRoute route) {
    return switch (route) {
      SplashRoute() => const SplashScreen(),
      LoginRoute() => const LoginScreen(),
      ServerPickRoute() => const ServerPickScreen(),
      OnboardingRecoveryRoute() => const RecoverySaveScreen(),
      OnboardingPrivacyRoute() => const PrivacyForkScreen(),
      OnboardingDistributorRoute() => const DistributorGuideScreen(),
      OnboardingLocationRoute() => const LocationPermissionScreen(),
      SettingsPrivacyRoute() => const PrivacySettingsScreen(),
      SettingsLookRoute() => const LookFeelScreen(),
      SettingsNotificationsRoute() => const NotificationsSettingsScreen(),
      SettingsAccountRoute() => const AccountScreen(),
      SettingsAboutRoute() => const AboutScreen(),
      IdentityRoute() => const IdentityScreen(),
      RecoveryRoute() => const RecoveryScreen(),
      GhostRoute() => const GhostScreen(),
      DeviceLinkRoute() => const DeviceLinkScreen(),
      PersonDetailRoute(:final userId) => PersonDetailScreen(userId: userId),
      AddPersonRoute(:final prefillHandle) => AddPersonScreen(
        prefillHandle: prefillHandle,
      ),
      MainShell() => KaiselBranchedShell.specs(
        branches: [
          KaiselBranchSpec<MapRoute>(
            initial: const MapRoot(),
            builder: (context, route) => switch (route) {
              MapRoot() => const MapScreen(),
            },
          ),
          KaiselBranchSpec<PeopleRoute>(
            initial: const PeopleRoot(),
            builder: (context, route) => switch (route) {
              PeopleRoot() => const PeopleScreen(),
            },
          ),
          KaiselBranchSpec<MeRoute>(
            initial: const MeRoot(),
            builder: (context, route) => switch (route) {
              MeRoot() => const MeScreen(),
            },
          ),
        ],
        branchContentBuilder: (context, active, branches, _) =>
            AnimatedBranchStack(
              activeBranch: active,
              branches: branches,
              reduced: _reducedMotion,
            ),
        chromeBuilder: (context, active, content, switchBranch) => ShellChrome(
          activeBranch: active,
          branchContent: content,
          onSwitch: (branch) {
            Haptics.tick(ref);
            switchBranch(branch);
          },
        ),
      ),
    };
  }

  @override
  Widget build(BuildContext context) {
    // Auth-driven routing WITHOUT resetting the router (D-015): flip the stack
    // via `router.set` on the one app-lifetime router instead of swapping the
    // MaterialApp. The shell + its per-branch state are never torn down.
    ref
      ..listen(authControllerProvider, (prev, next) {
        // Session-lifecycle side effects run only when the session IDENTITY
        // changes. Same-account re-emissions (a display-name update) must not
        // restart the relay or re-route; that stacked duplicate WS/fix
        // subscriptions and could double-process MLS messages.
        final prevId = prev?.value?.userId;
        next.whenData((session) {
          if (session != null) {
            if (session.userId == prevId) return;
            // Only an explicit login/register counts as a NEW session for the
            // go-dark-default policy (a cold-start restore must never override
            // a live sharing choice). The controller flags it, because both
            // sign-in and restore arrive here from AsyncLoading.
            if (ref
                .read(authControllerProvider.notifier)
                .consumeExplicitSignIn()) {
              unawaited(_applyGoDarkDefault());
            }
            // Wave D: register this device's wake transport (UnifiedPush
            // endpoint -> server) so offline share requests/accepts reach it.
            unawaited(ref.read(pushServiceProvider).sync());
            // M2: bring up the MLS relay (durable WS, KeyPackage pool,
            // encrypted fixes through the durable queue). The location engine
            // deliberately does NOT start here: its permission ask belongs to
            // the onboarding location step, and `continueOnboarding` starts
            // the engine once the gate is clear.
            ref.read(relayControllerProvider).start(session);
            // Launch gate: resume the first incomplete required step, or open
            // the shell (with any held deep-link invite).
            unawaited(continueOnboarding(ref, _config.router));
          } else {
            if (prevId == null) return; // already signed out; nothing to tear down
            ref.read(locationServiceProvider).setSharing(sharing: false);
            ref.read(relayControllerProvider).stop();
            // Drop this device's push registration for the account LEAVING
            // (prev still holds its session/token; next is already null).
            unawaited(
              ref.read(pushServiceProvider).teardown(prev?.value),
            );
            // An invite held for the previous account must not leak into
            // whichever account signs in next.
            ref.read(pendingInviteProvider.notifier).take();
            unawaited(_routeSignedOut());
          }
        });
      })
      // Wave D: re-register when the notification transport setting changes.
      // Leaving UnifiedPush tears down the old distributor+server endpoint
      // first so it isn't left live and still woken.
      ..listen(settingsProvider.select((s) => s.transport), (prev, next) {
        if (prev == null || prev == next) return;
        final push = ref.read(pushServiceProvider);
        if (prev == NotifTransport.unifiedPush &&
            next != NotifTransport.unifiedPush) {
          final session = ref.read(authControllerProvider).value;
          unawaited(push.teardown(session).then((_) => push.sync()));
        } else {
          unawaited(push.sync());
        }
      })
      // Feed the relay who we share with — ongoing shares AND active outgoing
      // temp targets — so it forms the MLS group with each (claim KP -> group ->
      // Welcome) and encrypts fixes to them. Null = shares still loading; skip
      // so a transient no-value never clears the encrypt-targets.
      ..listen(shareTargetsProvider, (prev, next) {
        if (next == null) return;
        ref
            .read(relayControllerProvider)
            .setShareTargets(next.all, forceInitiate: next.tempOnly);
      });

    final appearance = ref.watch(settingsProvider.select((s) => s.appearance));
    final textScale = ref.watch(settingsProvider.select((s) => s.textScale));
    return MaterialApp.router(
      title: 'Point',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(
        pureBlack: appearance == Appearance.pureBlack,
      ),
      themeMode: appearance == Appearance.light
          ? ThemeMode.light
          : ThemeMode.dark,
      // The app text-size setting COMPOSES with the OS scale: the OS scaler
      // applies first, then ours, so an accessibility choice is respected.
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(
          textScaler: _ComposedScaler(
            MediaQuery.textScalerOf(context),
            textScale,
          ),
        ),
        child: child ?? const SizedBox.shrink(),
      ),
      routerConfig: _config,
    );
  }
}

class _FadePage extends Page<Object?> {
  const _FadePage({required this.child, this.reduced = false, super.key});
  final Widget child;
  final bool reduced;

  @override
  Route<Object?> createRoute(BuildContext context) {
    return PageRouteBuilder<Object?>(
      settings: this,
      transitionDuration: reduced
          ? Duration.zero
          : const Duration(milliseconds: 220),
      pageBuilder: (_, _, _) => child,
      transitionsBuilder: (_, animation, _, child) =>
          FadeTransition(opacity: animation, child: child),
    );
  }
}

class _SlideUpPage extends Page<Object?> {
  const _SlideUpPage({required this.child, this.reduced = false, super.key});
  final Widget child;
  final bool reduced;

  @override
  Route<Object?> createRoute(BuildContext context) {
    return PageRouteBuilder<Object?>(
      settings: this,
      transitionDuration: reduced
          ? Duration.zero
          : const Duration(milliseconds: 320),
      reverseTransitionDuration: reduced
          ? Duration.zero
          : const Duration(milliseconds: 260),
      pageBuilder: (_, _, _) => child,
      transitionsBuilder: (_, animation, _, child) {
        final curved = CurvedAnimation(
          parent: animation,
          curve: Curves.easeOutCubic,
        );
        return FadeTransition(
          opacity: curved,
          child: SlideTransition(
            position: Tween<Offset>(
              begin: const Offset(0, 0.06),
              end: Offset.zero,
            ).animate(curved),
            child: child,
          ),
        );
      },
    );
  }
}

/// Shared app-bar brand mark: the filled "● Point" dot from the mockup.
class BrandDot extends StatelessWidget {
  const BrandDot({this.size = 10, super.key});
  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: context.colors.onSurface,
        shape: BoxShape.circle,
      ),
    );
  }
}

/// OS text scale first, then the app's own multiplier on top.
class _ComposedScaler extends TextScaler {
  const _ComposedScaler(this._system, this._app);
  final TextScaler _system;
  final double _app;

  @override
  double scale(double fontSize) => _system.scale(fontSize) * _app;

  @override
  // The base class still requires the deprecated member to be implemented.
  // ignore: deprecated_member_use
  double get textScaleFactor => _system.textScaleFactor * _app;
}
