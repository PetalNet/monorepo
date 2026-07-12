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
import 'package:point_app/features/ghost/presentation/ghost_screen.dart';
import 'package:point_app/features/location/location_providers.dart';
import 'package:point_app/features/map/presentation/map_screen.dart';
import 'package:point_app/features/people/invite.dart';
import 'package:point_app/features/people/people_controller.dart';
import 'package:point_app/features/people/presentation/add_person_screen.dart';
import 'package:point_app/features/people/presentation/people_screen.dart';
import 'package:point_app/features/people/presentation/person_detail_screen.dart';
import 'package:point_app/features/profile/presentation/profile_screen.dart';
import 'package:point_app/features/relay/relay_controller.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/theme/app_theme.dart';
import 'package:point_app/theme/theme_x.dart';

/// The app appearance (light / dark / pure-black). Persisted in M4; held in
/// memory for now, driven from Profile.
final appearanceProvider =
    NotifierProvider<AppearanceController, Appearance>(AppearanceController.new);

enum Appearance { light, dark, pureBlack }

class AppearanceController extends Notifier<Appearance> {
  @override
  Appearance build() => Appearance.dark;
  // A method (not a setter) reads more naturally at the call site
  // (`.select(Appearance.dark)`) for this small enum control.
  // ignore: use_setters_to_change_properties
  void select(Appearance a) => state = a;
}

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

  /// An invite handle captured from a deep link while signed out — opened once
  /// the session restores/signs in.
  String? _pendingInvite;

  @override
  void initState() {
    super.initState();
    // GO-bar #1: actually wire the app-lifecycle → background hooks the legacy
    // defined but never called. Without this the battery engine never learns
    // it's been backgrounded and location silently stops.
    WidgetsBinding.instance.addObserver(this);
    final loggedIn = ref.read(authControllerProvider.notifier).loggedIn;
    _config = KaiselRouterConfig<AppRoute>(
      initial: const SplashRoute(),
      guards: [_authGuard(loggedIn)],
      pageWrapper: _pageWrapper,
      builder: _pageForRoute,
    );
    // Invite deep links (point://add/<handle> and .../add/<handle>): the link
    // the app was launched from, plus any received while running.
    unawaited(_appLinks.getInitialLink().then((uri) {
      if (uri != null) _onInviteLink(uri);
    }));
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
    // Only open the add flow once signed in; otherwise hold it until auth.
    if (ref.read(authControllerProvider).value != null) {
      _config.router.set([const MainShell(), AddPersonRoute(prefillHandle: handle)]);
    } else {
      _pendingInvite = handle;
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final engine = ref.read(locationServiceProvider);
    switch (state) {
      case AppLifecycleState.resumed:
        engine.onForeground();
      case AppLifecycleState.paused:
      case AppLifecycleState.detached:
      case AppLifecycleState.hidden:
        engine.onBackground();
      case AppLifecycleState.inactive:
        break;
    }
  }

  /// Backstop guard for deep links: any authed route while signed out becomes
  /// Login. Primary auth-driven routing is the `router.set` listener below.
  KaiselGuard<AppRoute> _authGuard(ValueListenable<bool> loggedIn) {
    return (current, proposed) {
      final needsAuth = proposed.any(routeRequiresAuth);
      if (needsAuth && !loggedIn.value) return const [LoginRoute()];
      return proposed;
    };
  }

  /// Route-pair transitions (the acceptance-bar `pageWrapper`): full-screen
  /// modals (Ghost, Device-link) slide up; everything else fades.
  Page<Object?> _pageWrapper(KaiselPageWrapperContext<AppRoute> ctx) {
    return switch (ctx.route) {
      GhostRoute() ||
      DeviceLinkRoute() ||
      PersonDetailRoute() ||
      AddPersonRoute() =>
        _SlideUpPage(key: ctx.key, child: ctx.child),
      _ => _FadePage(key: ctx.key, child: ctx.child),
    };
  }

  Widget _pageForRoute(BuildContext context, AppRoute route) {
    return switch (route) {
      SplashRoute() => const SplashScreen(),
      LoginRoute() => const LoginScreen(),
      GhostRoute() => const GhostScreen(),
      DeviceLinkRoute() => const DeviceLinkScreen(),
      PersonDetailRoute(:final userId) => PersonDetailScreen(userId: userId),
      AddPersonRoute(:final prefillHandle) =>
        AddPersonScreen(prefillHandle: prefillHandle),
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
            KaiselBranchSpec<ProfileRoute>(
              initial: const ProfileRoot(),
              builder: (context, route) => switch (route) {
                ProfileRoot() => const ProfileScreen(),
              },
            ),
          ],
          branchContentBuilder: (context, active, branches, _) =>
              AnimatedBranchStack(activeBranch: active, branches: branches),
          chromeBuilder: (context, active, content, switchBranch) => ShellChrome(
            activeBranch: active,
            branchContent: content,
            onSwitch: switchBranch,
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
        next.whenData((session) {
          if (session != null) {
            // GO-bar #1: start the battery engine on sign-in (requests location
            // permission, then runs the accel wake-gate + adaptive GPS). Ghost
            // then drives share/hard-stop. Without this the engine only ran
            // under the soak harness, never the shipping app.
            ref.read(locationServiceProvider).start();
            // M2: bring up the MLS relay (durable WS, KeyPackage pool,
            // encrypted fixes through the durable queue).
            ref.read(relayControllerProvider).start(session);
            // Open a deep-link invite captured before sign-in, else the shell.
            final invite = _pendingInvite;
            _pendingInvite = null;
            _config.router.set([
              const MainShell(),
              if (invite != null) AddPersonRoute(prefillHandle: invite),
            ]);
          } else {
            ref.read(locationServiceProvider).setSharing(sharing: false);
            ref.read(relayControllerProvider).stop();
            _config.router.set(const [LoginRoute()]);
          }
        });
      })
      // Feed the relay who we share with, so it forms the MLS group with each
      // (claim KP -> group -> Welcome) and encrypts fixes to them.
      ..listen(peopleControllerProvider, (prev, next) {
        // Only act on a resolved list. A transient loading state (no retained
        // value) would otherwise clear every encrypt-target for a round-trip.
        if (!next.hasValue) return;
        final ids = next.value!.map((p) => p.userId).toList();
        ref.read(relayControllerProvider).setShareTargets(ids);
      });

    final appearance = ref.watch(appearanceProvider);
    return MaterialApp.router(
      title: 'Point',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(
        pureBlack: appearance == Appearance.pureBlack,
      ),
      themeMode:
          appearance == Appearance.light ? ThemeMode.light : ThemeMode.dark,
      routerConfig: _config,
    );
  }
}

class _FadePage extends Page<Object?> {
  const _FadePage({required this.child, super.key});
  final Widget child;

  @override
  Route<Object?> createRoute(BuildContext context) {
    return PageRouteBuilder<Object?>(
      settings: this,
      transitionDuration: const Duration(milliseconds: 220),
      pageBuilder: (_, _, _) => child,
      transitionsBuilder: (_, animation, _, child) =>
          FadeTransition(opacity: animation, child: child),
    );
  }
}

class _SlideUpPage extends Page<Object?> {
  const _SlideUpPage({required this.child, super.key});
  final Widget child;

  @override
  Route<Object?> createRoute(BuildContext context) {
    return PageRouteBuilder<Object?>(
      settings: this,
      transitionDuration: const Duration(milliseconds: 320),
      reverseTransitionDuration: const Duration(milliseconds: 260),
      pageBuilder: (_, _, _) => child,
      transitionsBuilder: (_, animation, _, child) {
        final curved =
            CurvedAnimation(parent: animation, curve: Curves.easeOutCubic);
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
