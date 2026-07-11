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
import 'package:point_app/features/map/presentation/map_screen.dart';
import 'package:point_app/features/people/presentation/people_screen.dart';
import 'package:point_app/features/profile/presentation/profile_screen.dart';
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

class _PointAppState extends ConsumerState<PointApp> {
  late final KaiselRouterConfig<AppRoute> _config;

  @override
  void initState() {
    super.initState();
    final loggedIn = ref.read(authControllerProvider.notifier).loggedIn;
    _config = KaiselRouterConfig<AppRoute>(
      initial: const SplashRoute(),
      guards: [_authGuard(loggedIn)],
      pageWrapper: _pageWrapper,
      builder: _buildPage,
    );
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
      GhostRoute() || DeviceLinkRoute() =>
        _SlideUpPage(key: ctx.key, child: ctx.child),
      _ => _FadePage(key: ctx.key, child: ctx.child),
    };
  }

  Widget _buildPage(BuildContext context, AppRoute route) {
    return switch (route) {
      SplashRoute() => const SplashScreen(),
      LoginRoute() => const LoginScreen(),
      GhostRoute() => const GhostScreen(),
      DeviceLinkRoute() => const DeviceLinkScreen(),
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
    ref.listen(authControllerProvider, (prev, next) {
      next.whenData((session) {
        _config.router.set(session != null
            ? const [MainShell()]
            : const [LoginRoute()]);
      });
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
